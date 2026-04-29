from fastapi import APIRouter, Depends, HTTPException, Request, Query
from sqlalchemy import text
from uuid import UUID
from typing import List, Optional

from ..db import get_db
from ..schemas import Approval, ApprovalCreate, ApprovalUpdate

router = APIRouter(prefix="/api/approvals", tags=["approvals"])


def _db(request: Request):
    return get_db(request.state.tenant_slug)


@router.get("", response_model=List[Approval])
async def list_approvals(
    request: Request,
    invoice_id: Optional[UUID] = Query(None),
    status: Optional[str] = Query(None),
):
    async for session in _db(request):
        conditions = ["1=1"]
        params: dict = {}
        if invoice_id:
            conditions.append("invoice_id = :invoice_id")
            params["invoice_id"] = str(invoice_id)
        if status:
            conditions.append("status = :status")
            params["status"] = status

        where = " AND ".join(conditions)
        result = await session.execute(
            text(f"SELECT * FROM approvals WHERE {where} ORDER BY created_at DESC"),
            params,
        )
        return [dict(r) for r in result.mappings().all()]


@router.post("", response_model=Approval, status_code=201)
async def create_approval(body: ApprovalCreate, request: Request):
    async for session in _db(request):
        # Verify invoice exists
        inv = await session.execute(
            text("SELECT id FROM invoices WHERE id = :id"),
            {"id": str(body.invoice_id)},
        )
        if not inv.one_or_none():
            raise HTTPException(status_code=404, detail="Invoice not found")

        result = await session.execute(
            text("""
                INSERT INTO approvals (invoice_id, approver_id, approver_name, comment)
                VALUES (:invoice_id, :approver_id, :approver_name, :comment)
                RETURNING *
            """),
            {
                "invoice_id": str(body.invoice_id),
                "approver_id": body.approver_id,
                "approver_name": body.approver_name,
                "comment": body.comment,
            },
        )
        await session.commit()
        return dict(result.mappings().one())


@router.get("/{approval_id}", response_model=Approval)
async def get_approval(approval_id: UUID, request: Request):
    async for session in _db(request):
        result = await session.execute(
            text("SELECT * FROM approvals WHERE id = :id"),
            {"id": str(approval_id)},
        )
        row = result.mappings().one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail="Approval not found")
        return dict(row)


@router.put("/{approval_id}", response_model=Approval)
async def update_approval(approval_id: UUID, body: ApprovalUpdate, request: Request):
    if body.status not in ("approved", "rejected"):
        raise HTTPException(status_code=400, detail="status must be 'approved' or 'rejected'")

    async for session in _db(request):
        result = await session.execute(
            text("""
                UPDATE approvals
                SET status = :status, comment = :comment, updated_at = NOW()
                WHERE id = :id
                RETURNING *
            """),
            {"status": body.status, "comment": body.comment, "id": str(approval_id)},
        )
        await session.commit()
        row = result.mappings().one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail="Approval not found")
        return dict(row)


@router.delete("/{approval_id}", status_code=204)
async def delete_approval(approval_id: UUID, request: Request):
    async for session in _db(request):
        result = await session.execute(
            text("DELETE FROM approvals WHERE id = :id RETURNING id"),
            {"id": str(approval_id)},
        )
        await session.commit()
        if not result.rowcount:
            raise HTTPException(status_code=404, detail="Approval not found")
