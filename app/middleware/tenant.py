import re
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from jose import JWTError

from ..services.auth_svc import decode_token
from ..db import AsyncSessionLocal
from sqlalchemy import text

# Paths that don't require a JWT
_PUBLIC_PATHS = {"/health", "/login"}
_PUBLIC_PREFIXES = ("/static", "/api/auth/login")

FIXED_SUBDOMAINS = {"invoice"}


class TenantMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Public routes — pass through without any auth
        if path in _PUBLIC_PATHS or any(path.startswith(p) for p in _PUBLIC_PREFIXES):
            return await call_next(request)

        # Non-API routes (SPA page navigation) — serve as-is; client handles auth
        if not path.startswith("/api/"):
            return await call_next(request)

        # API routes require a valid JWT
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return JSONResponse(status_code=401, content={"detail": "認証が必要です"})

        token = auth_header.split(" ", 1)[1]
        try:
            payload = decode_token(token)
        except JWTError:
            return JSONResponse(status_code=401, content={"detail": "無効または期限切れのトークンです"})

        request.state.user_id   = payload.get("sub")
        request.state.user_role = payload.get("role")

        # Resolve tenant slug
        tenant_slug = request.headers.get("X-Tenant-Slug")
        if not tenant_slug:
            host = request.headers.get("host", "")
            hostname = host.split(":")[0]
            parts = hostname.split(".")
            if (
                len(parts) >= 3
                and not hostname.endswith(".amazonaws.com")
                and not hostname.endswith(".elb.amazonaws.com")
                and parts[0] not in FIXED_SUBDOMAINS
            ):
                tenant_slug = parts[0]
        if not tenant_slug:
            tenant_slug = "demo"

        if not re.match(r"^[a-z0-9_-]+$", tenant_slug):
            return JSONResponse(status_code=400, content={"detail": "テナントIDの形式が正しくありません"})

        # Non-admin users: verify tenant access
        if request.state.user_role != "admin":
            async with AsyncSessionLocal() as session:
                row = (await session.execute(
                    text("SELECT 1 FROM public.user_tenants WHERE user_id = :uid AND tenant_slug = :slug"),
                    {"uid": request.state.user_id, "slug": tenant_slug},
                )).one_or_none()
                if not row:
                    return JSONResponse(status_code=403, content={"detail": "このテナントへのアクセス権限がありません"})

        request.state.tenant_slug = tenant_slug
        return await call_next(request)
