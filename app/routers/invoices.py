from fastapi import APIRouter, HTTPException, Request, UploadFile, File, Query
from sqlalchemy import text
from uuid import UUID, uuid4
from typing import List, Optional
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


def _db(request: Request):
    return get_db(request.state.tenant_slug)


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


@router.post("", response_model=Invoice, status_code=201)
async def upload_invoice(request: Request, file: UploadFile = File(...)):
    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    if ext not in ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

    content = await file.read()
    tenant_slug = request.state.tenant_slug
    file_id = uuid4()
    s3_key = f"tenants/{tenant_slug}/invoices/{file_id}.{ext}"
    content_type = CONTENT_TYPE_MAP.get(ext, "application/octet-stream")

    try:
        s3_svc.upload_file(content, s3_key, content_type)
    except Exception:
        # Fall through without S3 in local dev if credentials not set
        pass

    async for session in _db(request):
        result = await session.execute(
            text("""
                INSERT INTO invoices (id, s3_key, original_filename, file_type, status)
                VALUES (:id, :s3_key, :original_filename, :file_type, 'pending')
                RETURNING *
            """),
            {
                "id": str(file_id),
                "s3_key": s3_key,
                "original_filename": file.filename,
                "file_type": ext,
            },
        )
        await session.commit()
        return dict(result.mappings().one())


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
    async for session in _db(request):
        updates = {k: v for k, v in body.model_dump().items() if v is not None}
        if not updates:
            raise HTTPException(status_code=400, detail="No fields to update")

        # Serialize dict fields to JSON string for PostgreSQL
        params = {}
        set_parts = []
        for k, v in updates.items():
            if isinstance(v, dict):
                set_parts.append(f"{k} = :{k}::jsonb")
                params[k] = json.dumps(v)
            elif isinstance(v, UUID):
                set_parts.append(f"{k} = :{k}")
                params[k] = str(v)
            else:
                set_parts.append(f"{k} = :{k}")
                params[k] = v

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

        # Download file from S3 (skip gracefully if unavailable)
        file_content = b""
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
        except Exception:
            raise HTTPException(status_code=502, detail="Could not retrieve file from storage")

        # Claude extraction
        extracted = await claude_svc.extract_invoice_data(file_content, invoice.get("file_type", "pdf"))

        # Fetch companies for matching
        companies_result = await session.execute(
            text("SELECT id, name, registration_number FROM companies ORDER BY name")
        )
        companies = [
            {"company_id": str(r["id"]), "company_name": r["name"], "registration_number": r["registration_number"]}
            for r in companies_result.mappings().all()
        ]

        matches: list = []
        if companies:
            matches = await claude_svc.match_company(extracted, companies)

        # Persist extraction + top match
        top_match = matches[0] if matches else None
        await session.execute(
            text("""
                UPDATE invoices
                SET extracted_data = :extracted::jsonb,
                    status = 'processed',
                    company_id = :company_id,
                    matching_score = :score,
                    updated_at = NOW()
                WHERE id = :id
            """),
            {
                "extracted": json.dumps(extracted, ensure_ascii=False),
                "company_id": top_match["company_id"] if top_match and top_match["score"] >= 0.5 else None,
                "score": top_match["score"] if top_match else None,
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
