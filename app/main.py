from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import text
import os

from .config import settings
from .db import engine, AsyncSessionLocal
from .middleware.tenant import TenantMiddleware
from .routers import invoices, masters, approvals


async def _run_migrations():
    """Add AI usage columns to all existing tenant schemas."""
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                text("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'")
            )
            schemas = [r[0] for r in result]
            for schema in schemas:
                await session.execute(text(
                    f"ALTER TABLE {schema}.invoices "
                    f"ADD COLUMN IF NOT EXISTS ai_input_tokens INTEGER NOT NULL DEFAULT 0, "
                    f"ADD COLUMN IF NOT EXISTS ai_output_tokens INTEGER NOT NULL DEFAULT 0"
                ))
            await session.commit()
    except Exception as e:
        print(f"[migration] {e}")


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

app.include_router(invoices.router)
app.include_router(masters.router)
app.include_router(approvals.router)

# Serve frontend
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        return FileResponse(os.path.join(static_dir, "index.html"))


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/tenants/provision")
async def provision_tenant(slug: str, name: str):
    """Create a new tenant schema (admin endpoint)."""
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
