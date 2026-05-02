from fastapi import APIRouter, HTTPException, Request, UploadFile, File, Query
from sqlalchemy import text
from uuid import UUID, uuid4
from typing import List, Optional
from datetime import datetime, timezone
import json

from ..db import get_db
from ..schemas import Invoice, InvoiceUpdate, InvoiceWithMatches
from ..services import claude as claude_svc
from ..services import s3 as s3_svc
from ..config import settings

router = APIRouter(prefix="/api/invoices", tags=["invoices"])

ALLOWED_TYPES = {"pdf", "jpg", "jpeg", "png", "gif", "webp"}
CONTENT_TYPE_MAP = {
    "pdf": "application/pdf",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
}
_DOC_SEG = {"請求書": "invoice", "領収書": "receipt"}

# Pricing per 1M tokens (USD)
_MODEL_PRICING = {
    "claude-opus-4-5":   {"input": 15.0,  "output": 75.0},
    "claude-opus-4-7":   {"input": 15.0,  "output": 75.0},
    "claude-sonnet-4-6": {"input": 3.0,   "output": 15.0},
    "claude-haiku-4-5":  {"input": 0.25,  "output": 1.25},
}
_USD_TO_JPY = 150


def _db(request: Request):
    return get_db(request.state.tenant_slug)


def _s3_dir(tenant_slug: str, company_id, doc_type: Optional[str]) -> str:
    c_seg = str(company_id) if company_id else "unassigned"
    d_seg = _DOC_SEG.get(doc_type or "", "unknown")
    return f"tenants/{tenant_slug}/{c_seg}/{d_seg}"


def _build_s3_key(tenant_slug: str, company_id, doc_type: Optional[str], ext: str) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return f"{_s3_dir(tenant_slug, company_id, doc_type)}/{ts}.{ext}"


def _rekey(old_key: str, tenant_slug: str, company_id, doc_type: Optional[str], content_type: str) -> str:
    """Move S3 file to new directory if company/doc_type changed. Preserves timestamp filename."""
    filename = old_key.rsplit("/", 1)[-1]
    new_key = f"{_s3_dir(tenant_slug, company_id, doc_type)}/{filename}"
    if new_key != old_key:
        s3_svc.move_file(old_key, new_key, content_type)
    return new_key


def _calc_cost(input_tokens: int, output_tokens: int) -> dict:
    pricing = _MODEL_PRICING.get(settings.CLAUDE_MODEL, {"input": 15.0, "output": 75.0})
    cost_usd = (input_tokens * pricing["input"] + output_tokens * pricing["output"]) / 1_000_000
    return {"cost_usd": round(cost_usd, 6), "cost_jpy": round(cost_usd * _USD_TO_JPY, 2)}


@router.get("", response_model=List[Invoice])
async def list_invoices(
    request: Request,
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    async for session in _db(request):
        conditions = ["1=1"]
        params: dict = {"limit": limit, "offset": offset}
        if status:
            conditions.append("status = :status")
            params["status"] = status

        where = " AND ".join(conditions)
        result = await session.execute(
            text(f"SELECT * FROM invoices WHERE {where} ORDER BY created_at DESC LIMIT :limit OFFSET :offset"),
            params,
        )
        return [dict(r) for r in result.mappings().all()]


@router.get("/usage-stats")
async def usage_stats(request: Request):
    """AI usage statistics for this tenant."""
    async for session in _db(request):
        result = await session.execute(text("""
            SELECT
                COUNT(*) AS total_invoices,
                COUNT(*) FILTER (WHERE ai_input_tokens > 0) AS ai_processed,
                COALESCE(SUM(ai_input_tokens), 0)  AS input_tokens,
                COALESCE(SUM(ai_output_tokens), 0) AS output_tokens
            FROM invoices
        """))
        row = dict(result.mappings().one())
        cost = _calc_cost(row["input_tokens"], row["output_tokens"])
        return {**row, **cost, "model": settings.CLAUDE_MODEL}


@router.post("", response_model=InvoiceWithMatches, status_code=201)
async def upload_invoice(request: Request, file: UploadFile = File(...)):
    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    if ext not in ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

    content = await file.read()
    tenant_slug = request.state.tenant_slug
    file_id = uuid4()
    content_type = CONTENT_TYPE_MAP.get(ext, "application/octet-stream")

    extracted, usage_extract = await claude_svc.extract_invoice_data(content, ext)

    async for session in _db(request):
        companies_result = await session.execute(
            text("SELECT id, name, registration_number FROM companies ORDER BY name")
        )
        companies = [
            {"company_id": str(r["id"]), "company_name": r["name"], "registration_number": r["registration_number"]}
            for r in companies_result.mappings().all()
        ]

        usage_match = {"input_tokens": 0, "output_tokens": 0}
        matches: list = []
        if companies:
            matches, usage_match = await claude_svc.match_company(extracted, companies)

        top_match = matches[0] if matches else None
        company_id = top_match["company_id"] if top_match and top_match["score"] >= 0.5 else None
        doc_type = extracted.get("document_type")

        total_input  = usage_extract["input_tokens"]  + usage_match["input_tokens"]
        total_output = usage_extract["output_tokens"] + usage_match["output_tokens"]

        s3_key = _build_s3_key(tenant_slug, company_id, doc_type, ext)
        try:
            s3_svc.upload_file(content, s3_key, content_type)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Failed to upload file to storage: {e}")

        result = await session.execute(
            text("""
                INSERT INTO invoices
                    (id, s3_key, original_filename, file_type, status,
                     extracted_data, company_id, matching_score,
                     ai_input_tokens, ai_output_tokens)
                VALUES
                    (:id, :s3_key, :original_filename, :file_type, 'processed',
                     CAST(:extracted AS jsonb), :company_id, :score,
                     :ai_in, :ai_out)
                RETURNING *
            """),
            {
                "id": str(file_id),
                "s3_key": s3_key,
                "original_filename": file.filename,
                "file_type": ext,
                "extracted": json.dumps(extracted, ensure_ascii=False),
                "company_id": company_id,
                "score": top_match["score"] if top_match else None,
                "ai_in": total_input,
                "ai_out": total_output,
            },
        )
        await session.commit()
        invoice = dict(result.mappings().one())
        return {**invoice, "match_candidates": matches}


@router.get("/{invoice_id}", response_model=Invoice)
async def get_invoice(invoice_id: UUID, request: Request):
    async for session in _db(request):
        result = await session.execute(
            text("SELECT * FROM invoices WHERE id = :id"),
            {"id": str(invoice_id)},
        )
        row = result.mappings().one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail="Invoice not found")
        return dict(row)


@router.put("/{invoice_id}", response_model=Invoice)
async def update_invoice(invoice_id: UUID, body: InvoiceUpdate, request: Request):
    tenant_slug = request.state.tenant_slug

    async for session in _db(request):
        cur_row = await session.execute(
            text("SELECT s3_key, company_id, file_type, extracted_data FROM invoices WHERE id = :id"),
            {"id": str(invoice_id)},
        )
        current = cur_row.mappings().one_or_none()
        if not current:
            raise HTTPException(status_code=404, detail="Invoice not found")
        current = dict(current)

        updates = {k: v for k, v in body.model_dump().items() if v is not None}
        if not updates:
            raise HTTPException(status_code=400, detail="No fields to update")

        new_company_id = (
            str(updates["company_id"]) if "company_id" in updates
            else (str(current["company_id"]) if current.get("company_id") else None)
        )
        cur_data = current.get("extracted_data") or {}
        new_doc_type = (
            (updates.get("extracted_data") or {}).get("document_type")
            or cur_data.get("document_type")
        )

        old_key = current["s3_key"]
        file_ext = (current.get("file_type") or "").lower()
        content_type = CONTENT_TYPE_MAP.get(file_ext, "application/octet-stream")
        new_key = _rekey(old_key, tenant_slug, new_company_id, new_doc_type, content_type)

        params: dict = {}
        set_parts: list = []
        for k, v in updates.items():
            if isinstance(v, dict):
                set_parts.append(f"{k} = CAST(:{k} AS jsonb)")
                params[k] = json.dumps(v)
            elif isinstance(v, UUID):
                set_parts.append(f"{k} = :{k}")
                params[k] = str(v)
            else:
                set_parts.append(f"{k} = :{k}")
                params[k] = v

        if new_key != old_key:
            set_parts.append("s3_key = :s3_key")
            params["s3_key"] = new_key

        params["id"] = str(invoice_id)
        set_clause = ", ".join(set_parts)

        result = await session.execute(
            text(f"UPDATE invoices SET {set_clause}, updated_at = NOW() WHERE id = :id RETURNING *"),
            params,
        )
        await session.commit()
        row = result.mappings().one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail="Invoice not found")
        return dict(row)


@router.delete("/{invoice_id}", status_code=204)
async def delete_invoice(invoice_id: UUID, request: Request):
    async for session in _db(request):
        row = await session.execute(
            text("SELECT s3_key FROM invoices WHERE id = :id"),
            {"id": str(invoice_id)},
        )
        rec = row.one_or_none()
        if not rec:
            raise HTTPException(status_code=404, detail="Invoice not found")

        try:
            s3_svc.delete_file(rec[0])
        except Exception:
            pass

        await session.execute(
            text("DELETE FROM invoices WHERE id = :id"),
            {"id": str(invoice_id)},
        )
        await session.commit()


@router.post("/{invoice_id}/process", response_model=InvoiceWithMatches)
async def process_invoice(invoice_id: UUID, request: Request):
    """Run AI OCR extraction and company matching."""
    tenant_slug = request.state.tenant_slug

    async for session in _db(request):
        row = await session.execute(
            text("SELECT * FROM invoices WHERE id = :id"),
            {"id": str(invoice_id)},
        )
        invoice = row.mappings().one_or_none()
        if not invoice:
            raise HTTPException(status_code=404, detail="Invoice not found")
        invoice = dict(invoice)

        try:
            import boto3
            s3 = boto3.client(
                "s3",
                region_name=settings.AWS_REGION,
                aws_access_key_id=settings.AWS_ACCESS_KEY_ID or None,
                aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY or None,
            )
            resp = s3.get_object(Bucket=settings.S3_BUCKET_NAME, Key=invoice["s3_key"])
            file_content = resp["Body"].read()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Could not retrieve file from storage: {e}")

        extracted, usage_extract = await claude_svc.extract_invoice_data(file_content, invoice.get("file_type", "pdf"))

        companies_result = await session.execute(
            text("SELECT id, name, registration_number FROM companies ORDER BY name")
        )
        companies = [
            {"company_id": str(r["id"]), "company_name": r["name"], "registration_number": r["registration_number"]}
            for r in companies_result.mappings().all()
        ]

        usage_match = {"input_tokens": 0, "output_tokens": 0}
        matches: list = []
        if companies:
            matches, usage_match = await claude_svc.match_company(extracted, companies)

        top_match = matches[0] if matches else None
        new_company_id = top_match["company_id"] if top_match and top_match["score"] >= 0.5 else None
        new_doc_type = extracted.get("document_type")

        total_input  = usage_extract["input_tokens"]  + usage_match["input_tokens"]
        total_output = usage_extract["output_tokens"] + usage_match["output_tokens"]

        old_key = invoice["s3_key"]
        file_ext = (invoice.get("file_type") or "").lower()
        content_type = CONTENT_TYPE_MAP.get(file_ext, "application/octet-stream")
        new_key = _rekey(old_key, tenant_slug, new_company_id, new_doc_type, content_type)

        await session.execute(
            text("""
                UPDATE invoices
                SET extracted_data  = :extracted::jsonb,
                    status          = 'processed',
                    company_id      = :company_id,
                    matching_score  = :score,
                    s3_key          = :s3_key,
                    ai_input_tokens  = ai_input_tokens  + :ai_in,
                    ai_output_tokens = ai_output_tokens + :ai_out,
                    updated_at      = NOW()
                WHERE id = :id
            """),
            {
                "extracted": json.dumps(extracted, ensure_ascii=False),
                "company_id": new_company_id,
                "score": top_match["score"] if top_match else None,
                "s3_key": new_key,
                "ai_in": total_input,
                "ai_out": total_output,
                "id": str(invoice_id),
            },
        )
        await session.commit()

        updated = dict((await session.execute(
            text("SELECT * FROM invoices WHERE id = :id"),
            {"id": str(invoice_id)},
        )).mappings().one())

        return {**updated, "match_candidates": matches}


@router.get("/{invoice_id}/download-url")
async def get_download_url(invoice_id: UUID, request: Request):
    async for session in _db(request):
        row = await session.execute(
            text("SELECT s3_key FROM invoices WHERE id = :id"),
            {"id": str(invoice_id)},
        )
        rec = row.one_or_none()
        if not rec:
            raise HTTPException(status_code=404, detail="Invoice not found")

        url = s3_svc.get_presigned_url(rec[0])
        return {"url": url}
