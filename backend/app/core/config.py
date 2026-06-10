"""Application configuration, loaded from environment variables.

In production on SAP BTP, bind these via user-provided service / credential
store or the destination service rather than committing them. Never ship a
default SECRET_KEY to production — startup will warn if the dev default is used.
"""
from functools import lru_cache
from typing import List

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- App ---
    APP_NAME: str = "STAR — SAP Transformation Accelerator Roadmap"
    API_PREFIX: str = "/api"
    ENV: str = "development"

    # --- Security ---
    # CHANGE THIS in production. Generate with: openssl rand -hex 32
    SECRET_KEY: str = "dev-only-insecure-secret-change-me-please-0000000000000000"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    BCRYPT_ROUNDS: int = 12

    # --- CORS (comma-separated origins) ---
    CORS_ORIGINS: List[str] = [
        "http://localhost:3000", "http://127.0.0.1:3000",  # Next.js dev
        "http://localhost:5173", "http://127.0.0.1:5173",  # Vite dev
    ]

    # --- Database ---
    DATABASE_URL: str = "sqlite:///./star.db"

    # --- Bootstrap admin (seeded on first start if no users exist) ---
    FIRST_ADMIN_USERNAME: str = "admin"
    FIRST_ADMIN_EMAIL: str = "admin@example.com"
    FIRST_ADMIN_PASSWORD: str = "ChangeMe!2026"

    # --- LLM Narrative (optional — app runs fully offline if not set) ---
    # Set USE_LLM_NARRATIVE=true + one of the provider keys to activate.
    # LLM_PROVIDER: anthropic | openai | groq | sap_ai_core
    USE_LLM_NARRATIVE: bool = False
    LLM_PROVIDER: str = "anthropic"
    LLM_MODEL: str = "claude-sonnet-4-6"
    # If the primary provider fails, automatically retry with the fallback.
    # Set LLM_FALLBACK_PROVIDER=anthropic so SAP AI Core outages don't break narratives.
    LLM_FALLBACK_PROVIDER: str = ""
    LLM_FALLBACK_MODEL: str = "claude-sonnet-4-6"
    LLM_MAX_TOKENS: int = 900
    LLM_TEMPERATURE: float = 0.2
    ANTHROPIC_API_KEY: str = ""
    OPENAI_API_KEY: str = ""
    GROQ_API_KEY: str = ""
    # SAP Gen AI Hub — accepts both AICORE_* and SAP_AI_CORE_* naming
    AICORE_BASE_URL: str = ""
    AICORE_CLIENT_ID: str = ""
    AICORE_CLIENT_SECRET: str = ""
    AICORE_AUTH_URL: str = ""
    AICORE_RESOURCE_GROUP: str = "default"
    AICORE_MODEL: str = "gpt-4o"
    SAP_AI_CORE_DEPLOYMENT_ID: str = ""

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_origins(cls, v):
        if isinstance(v, str):
            v = v.strip()
            # Accept JSON array format (pydantic-settings v2 standard) or comma-separated.
            if v.startswith("["):
                import json as _json
                return _json.loads(v)
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @property
    def is_production(self) -> bool:
        return self.ENV.lower() in {"production", "prod"}


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
