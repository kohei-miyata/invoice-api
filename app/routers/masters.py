from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID
from typing import List

from ..db import get_db
from ..schemas import Company, CompanyCreate, CompanyUpdate

router = APIRouter(prefix="/api/masters", tags=["masters"])


def _db(request: Request):
    return get_db(request.state.tenant_slug)


@router.get("", response_model=List[Company])
async def list_companies(request: Request):
    async for session in _db(request):
        result = await session.execute(
            text("SELECT * FROM companies ORDER BY name")
        )
        rows = result.mappings().all()
        return [dict(r) for r in rows]


@router.post("", response_model=Company, status_code=201)
async def create_company(body: CompanyCreate, request: Request):
    async for session in _db(request):
        result = await session.execute(
            text("""
                INSERT INTO companies (name, registration_number, address, phone, email, notes)
                VALUES (:name, :registration_number, :address, :phone, :email, :notes)
                RETURNING *
            """),
            body.model_dump(),
        )
        await session.commit()
        return dict(result.mappings().one())


@router.get("/{company_id}", response_model=Company)
async def get_company(company_id: UUID, request: Request):
    async for session in _db(request):
        result = await session.execute(
            text("SELECT * FROM companies WHERE id = :id"),
            {"id": str(company_id)},
        )
        row = result.mappings().one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail="Company not found")
        return dict(row)


@router.put("/{company_id}", response_model=Company)
async def update_company(company_id: UUID, body: CompanyUpdate, request: Request):
    async for session in _db(request):
        updates = {k: v for k, v in body.model_dump().items() if v is not None}
        if not updates:
            raise HTTPException(status_code=400, detail="No fields to update")

        set_clause = ", ".join(f"{k} = :{k}" for k in updates)
        updates["id"] = str(company_id)
        updates["updated_at"] = "NOW()"

        result = await session.execute(
            text(f"""
                UPDATE companies
                SET {set_clause}, updated_at = NOW()
                WHERE id = :id
                RETURNING *
            """),
            updates,
        )
        await session.commit()
        row = result.mappings().one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail="Company not found")
        return dict(row)


@router.delete("/{company_id}", status_code=204)
async def delete_company(company_id: UUID, request: Request):
    async for session in _db(request):
        result = await session.execute(
            text("DELETE FROM companies WHERE id = :id RETURNING id"),
            {"id": str(company_id)},
        )
        await session.commit()
        if not result.rowcount:
            raise HTTPException(status_code=404, detail="Company not found")
