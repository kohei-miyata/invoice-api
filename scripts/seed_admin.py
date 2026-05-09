"""Run: docker compose exec api python scripts/seed_admin.py"""
import asyncio, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from sqlalchemy import text
from app.db import AsyncSessionLocal
from app.services.auth_svc import hash_password

EMAIL    = "kohei.miyata.km@gmail.com"
PASSWORD = "kohei1024"
NAME     = "宮田 航平"

async def main():
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
        await session.execute(text("""
            INSERT INTO public.users (email, password_hash, name, role)
            VALUES (:email, :hash, :name, 'admin')
            ON CONFLICT (email) DO UPDATE
                SET password_hash = EXCLUDED.password_hash,
                    role          = 'admin',
                    is_active     = true
        """), {"email": EMAIL, "hash": hash_password(PASSWORD), "name": NAME})
        await session.commit()
        print(f"OK: {EMAIL}")

asyncio.run(main())
