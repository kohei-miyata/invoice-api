from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import text
from uuid import UUID

from ..db import AsyncSessionLocal
from ..schemas import UserCreate, UserUpdate, UserResponse, TenantInfo
from ..services.auth_svc import hash_password

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _require_admin(request: Request):
    if getattr(request.state, "user_role", None) != "admin":
        raise HTTPException(status_code=403, detail="管理者権限が必要です")


async def _user_response(session, user_id: str) -> UserResponse:
    row = (await session.execute(
        text("SELECT * FROM public.users WHERE id = :id"),
        {"id": user_id},
    )).mappings().one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="ユーザーが見つかりません")

    if row["role"] == "admin":
        tenants = [dict(r) for r in (await session.execute(
            text("SELECT slug, name FROM public.tenants ORDER BY name")
        )).mappings().all()]
    else:
        tenants = [dict(r) for r in (await session.execute(
            text("""SELECT t.slug, t.name FROM public.tenants t
                    JOIN public.user_tenants ut ON t.slug = ut.tenant_slug
                    WHERE ut.user_id = :uid ORDER BY t.name"""),
            {"uid": user_id},
        )).mappings().all()]

    return UserResponse(
        id=row["id"],
        email=row["email"],
        name=row["name"],
        role=row["role"],
        is_active=row["is_active"],
        tenants=[TenantInfo(slug=t["slug"], name=t["name"]) for t in tenants],
        created_at=row["created_at"],
    )


@router.get("/users")
async def list_users(request: Request):
    _require_admin(request)
    async with AsyncSessionLocal() as session:
        rows = (await session.execute(
            text("SELECT * FROM public.users ORDER BY created_at")
        )).mappings().all()
        result = []
        for row in rows:
            result.append(await _user_response(session, str(row["id"])))
        return result


@router.post("/users", status_code=201)
async def create_user(body: UserCreate, request: Request):
    _require_admin(request)
    async with AsyncSessionLocal() as session:
        existing = (await session.execute(
            text("SELECT id FROM public.users WHERE email = :email"),
            {"email": body.email},
        )).one_or_none()
        if existing:
            raise HTTPException(status_code=409, detail="このメールアドレスはすでに登録されています")

        result = await session.execute(
            text("""INSERT INTO public.users (email, password_hash, name, role)
                    VALUES (:email, :hash, :name, :role) RETURNING id"""),
            {"email": body.email, "hash": hash_password(body.password),
             "name": body.name, "role": body.role},
        )
        user_id = str(result.scalar_one())

        if body.role != "admin" and body.tenant_slugs:
            for slug in body.tenant_slugs:
                await session.execute(
                    text("INSERT INTO public.user_tenants (user_id, tenant_slug) VALUES (:uid, :slug) ON CONFLICT DO NOTHING"),
                    {"uid": user_id, "slug": slug},
                )
        await session.commit()
        return await _user_response(session, user_id)


@router.put("/users/{user_id}")
async def update_user(user_id: UUID, body: UserUpdate, request: Request):
    _require_admin(request)
    async with AsyncSessionLocal() as session:
        sets, params = [], {"id": str(user_id)}
        if body.email is not None:
            sets.append("email = :email"); params["email"] = body.email
        if body.password is not None:
            sets.append("password_hash = :hash"); params["hash"] = hash_password(body.password)
        if body.name is not None:
            sets.append("name = :name"); params["name"] = body.name
        if body.role is not None:
            sets.append("role = :role"); params["role"] = body.role
        if body.is_active is not None:
            sets.append("is_active = :active"); params["active"] = body.is_active

        if sets:
            await session.execute(
                text(f"UPDATE public.users SET {', '.join(sets)}, updated_at = NOW() WHERE id = :id"),
                params,
            )

        if body.tenant_slugs is not None:
            await session.execute(
                text("DELETE FROM public.user_tenants WHERE user_id = :uid"),
                {"uid": str(user_id)},
            )
            for slug in body.tenant_slugs:
                await session.execute(
                    text("INSERT INTO public.user_tenants (user_id, tenant_slug) VALUES (:uid, :slug) ON CONFLICT DO NOTHING"),
                    {"uid": str(user_id), "slug": slug},
                )
        await session.commit()
        return await _user_response(session, str(user_id))


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: UUID, request: Request):
    _require_admin(request)
    if str(user_id) == request.state.user_id:
        raise HTTPException(status_code=400, detail="自分自身は削除できません")
    async with AsyncSessionLocal() as session:
        await session.execute(
            text("DELETE FROM public.users WHERE id = :id"), {"id": str(user_id)}
        )
        await session.commit()


@router.get("/tenants")
async def list_tenants(request: Request):
    _require_admin(request)
    async with AsyncSessionLocal() as session:
        rows = (await session.execute(
            text("SELECT slug, name FROM public.tenants ORDER BY name")
        )).mappings().all()
        return [{"slug": r["slug"], "name": r["name"]} for r in rows]

