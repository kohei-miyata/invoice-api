from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/invoices"
    ANTHROPIC_API_KEY: str = ""
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_REGION: str = "ap-northeast-1"
    S3_BUCKET_NAME: str = "invoice-bucket"
    CORS_ORIGINS: List[str] = ["*"]
    CLAUDE_MODEL: str = "claude-opus-4-5"

    class Config:
        env_file = ".env"


settings = Settings()
