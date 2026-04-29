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

app = FastAPI(
    title="Invoice Manager API",
    version="1.0.0",
    description="請求書・領収書管理SaaS",
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

    @app.get("/")
    async def serve_index():
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
