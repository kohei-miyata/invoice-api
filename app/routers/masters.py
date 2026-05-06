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


async def _check_duplicate(session, name: str, registration_number, exclude_id=None):
    params = {"name": name, "reg": registration_number}
    exclude_clause = "AND id != :exclude_id" if exclude_id else ""
    if exclude_id:
        params["exclude_id"] = str(exclude_id)
    row = (await session.execute(
        text(f"""
            SELECT name, registration_number FROM companies
            WHERE (name = :name OR (registration_number IS NOT NULL AND registration_number = :reg AND :reg IS NOT NULL))
            {exclude_clause}
            LIMIT 1
        """),
        params,
    )).mappings().one_or_none()
    if not row:
        return
    if row["name"] == name:
        raise HTTPException(status_code=409, detail="同じ会社名がすでに登録されています")
    raise HTTPException(status_code=409, detail="同じ登録番号がすでに登録されています")


@router.post("", response_model=Company, status_code=201)
async def create_company(body: CompanyCreate, request: Request):
    async for session in _db(request):
        await _check_duplicate(session, body.name, body.registration_number)
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
        if "name" in updates or "registration_number" in updates:
            cur = (await session.execute(
                text("SELECT name, registration_number FROM companies WHERE id = :id"),
                {"id": str(company_id)},
            )).mappings().one_or_none()
            if not cur:
                raise HTTPException(status_code=404, detail="Company not found")
            await _check_duplicate(
                session,
                updates.get("name", cur["name"]),
                updates.get("registration_number", cur["registration_number"]),
                exclude_id=company_id,
            )

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
