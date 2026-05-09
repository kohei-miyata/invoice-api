from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import text
import os

from .config import settings
from .db import AsyncSessionLocal
from .middleware.tenant import TenantMiddleware
from .routers import invoices, masters, approvals
from .routers import auth as auth_router
from .routers import admin as admin_router


async def _run_migrations():
    # Step 1: AI token columns per tenant schema (best-effort, one tx per schema)
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                text("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'")
            )
            schemas = [r[0] for r in result]
        for schema in schemas:
            try:
                async with AsyncSessionLocal() as session:
                    await session.execute(text(
                        f"ALTER TABLE {schema}.invoices "
                        f"ADD COLUMN IF NOT EXISTS ai_input_tokens INTEGER NOT NULL DEFAULT 0, "
                        f"ADD COLUMN IF NOT EXISTS ai_output_tokens INTEGER NOT NULL DEFAULT 0"
                    ))
                    await session.commit()
            except Exception as e:
                print(f"[migration] ai_tokens/{schema}: {e}")
    except Exception as e:
        print(f"[migration] schema list: {e}")

    # Step 2a: users table
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(text("""
                CREATE TABLE IF NOT EXISTS public.users (
                    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
                    email         VARCHAR(255) UNIQUE NOT NULL,
                    password_hash VARCHAR(255) NOT NULL,
                    name          VARCHAR(255),
                    role          VARCHAR(50)  NOT NULL DEFAULT 'user',
                    is_active     BOOLEAN      NOT NULL DEFAULT true,
                    created_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
                    updated_at    TIMESTAMP    NOT NULL DEFAULT NOW()
                )
            """))
            await session.commit()
            print("[migration] public.users ready")
    except Exception as e:
        print(f"[migration] public.users: {e}")

    # Step 2b: user_tenants table (depends on users + tenants)
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(text("""
                CREATE TABLE IF NOT EXISTS public.user_tenants (
                    user_id     UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
                    tenant_slug VARCHAR(50) NOT NULL REFERENCES public.tenants(slug) ON DELETE CASCADE,
                    PRIMARY KEY (user_id, tenant_slug)
                )
            """))
            await session.commit()
            print("[migration] public.user_tenants ready")
    except Exception as e:
        print(f"[migration] public.user_tenants: {e}")



@asynccontextmanager
async def lifespan(app: FastAPI):
    await _run_migrations()
    yield


app = FastAPI(
    title="Invoice Manager API",
    version="1.0.0",
    description="請求書・領収書管理SaaS",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(TenantMiddleware)

app.include_router(auth_router.router)
app.include_router(admin_router.router)
app.include_router(invoices.router)
app.include_router(masters.router)
app.include_router(approvals.router)


@app.get("/health")
async def health():
    return {"status": "ok"}


# Serve frontend
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        if full_path == "login":
            return FileResponse(os.path.join(static_dir, "login.html"))
        return FileResponse(os.path.join(static_dir, "index.html"))


@app.post("/api/tenants/provision")
async def provision_tenant(slug: str, name: str):
    import re
    if not re.match(r"^[a-z0-9_-]+$", slug):
        return JSONResponse(status_code=400, content={"detail": "Invalid slug"})
    async with AsyncSessionLocal() as session:
        await session.execute(
            text("SELECT public.provision_tenant(:slug, :name)"),
            {"slug": slug, "name": name},
        )
        await session.commit()
    return {"slug": slug, "name": name, "status": "provisioned"}
