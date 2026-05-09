from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import text

from ..db import AsyncSessionLocal
from ..schemas import LoginRequest, TokenResponse, UserResponse, TenantInfo
from ..services.auth_svc import verify_password, create_access_token

router = APIRouter(prefix="/api/auth", tags=["auth"])


async def _get_user_with_tenants(session, user_id: str) -> dict:
    row = (await session.execute(
        text("SELECT * FROM public.users WHERE id = :id AND is_active = true"),
        {"id": user_id},
    )).mappings().one_or_none()
    if not row:
        return None
    user = dict(row)

    if user["role"] == "admin":
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

    user["tenants"] = [TenantInfo(slug=t["slug"], name=t["name"]) for t in tenants]
    return user


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest):
    async with AsyncSessionLocal() as session:
        row = (await session.execute(
            text("SELECT * FROM public.users WHERE email = :email AND is_active = true"),
            {"email": body.email},
        )).mappings().one_or_none()

        if not row or not verify_password(body.password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="メールアドレスまたはパスワードが正しくありません")

        user = await _get_user_with_tenants(session, str(row["id"]))
        token = create_access_token({"sub": str(row["id"]), "role": row["role"]})
        return {
            "access_token": token,
            "token_type": "bearer",
            "user": UserResponse(
                id=user["id"],
                email=user["email"],
                name=user["name"],
                role=user["role"],
                is_active=user["is_active"],
                tenants=user["tenants"],
                created_at=user["created_at"],
            ),
        }


@router.get("/me", response_model=UserResponse)
async def me(request: Request):
    user_id = request.state.user_id
    async with AsyncSessionLocal() as session:
        user = await _get_user_with_tenants(session, user_id)
        if not user:
            raise HTTPException(status_code=401, detail="ユーザーが見つかりません")
        return UserResponse(
            id=user["id"],
            email=user["email"],
            name=user["name"],
            role=user["role"],
            is_active=user["is_active"],
            tenants=user["tenants"],
            created_at=user["created_at"],
        )
