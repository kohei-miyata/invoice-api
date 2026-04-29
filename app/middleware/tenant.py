from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse


class TenantMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Static files and health check bypass tenant check
        if request.url.path.startswith("/static") or request.url.path in ("/health", "/"):
            return await call_next(request)

        # Local dev: explicit header takes priority
        tenant_slug = request.headers.get("X-Tenant-Slug")

        if not tenant_slug:
            # Production: derive from subdomain
            host = request.headers.get("host", "")
            hostname = host.split(":")[0]  # strip port
            parts = hostname.split(".")
            if len(parts) >= 3:
                tenant_slug = parts[0]

        if not tenant_slug:
            return JSONResponse(
                status_code=400,
                content={"detail": "Tenant could not be identified. Provide X-Tenant-Slug header."},
            )

        # Sanitize: allow only alphanumeric + hyphen/underscore
        import re
        if not re.match(r"^[a-z0-9_-]+$", tenant_slug):
            return JSONResponse(
                status_code=400,
                content={"detail": "Invalid tenant slug format."},
            )

        request.state.tenant_slug = tenant_slug
        return await call_next(request)
