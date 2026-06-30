from pydantic_settings import BaseSettings
from pydantic import Field

class Settings(BaseSettings):
    DATABASE_URL: str = Field(default="postgresql+asyncpg://helper_user:helper_password@localhost:5432/helper_db")
    REDIS_URL: str = Field(default="redis://localhost:6379/0")
    OPENAI_API_KEY: str = Field(default="")
    GATEWAY_URL: str = Field(default="http://localhost:3000")
    CONFIDENCE_THRESHOLD: float = Field(default=0.7)
    BUFFER_TIMEOUT_SECONDS: int = Field(default=5)

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

settings = Settings()
