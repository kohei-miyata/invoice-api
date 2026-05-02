from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import text
from .config import settings

engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
)

AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_db(tenant_slug: str):
    async with AsyncSessionLocal() as session:
        schema = f"tenant_{tenant_slug}"
        await session.execute(text(f'SET search_path = "{schema}", public'))
        yield session
