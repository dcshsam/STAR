"""Database setup and ORM models (SQLModel).

Dev uses SQLite for zero-config local runs. In production, point DATABASE_URL at
SAP HANA Cloud or PostgreSQL (set the matching SQLAlchemy driver) and run proper
migrations (e.g. Alembic) instead of create_all.
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Column
from sqlalchemy.types import JSON, Text
from sqlmodel import Field, Session, SQLModel, create_engine

from app.core.config import settings

connect_args = {"check_same_thread": False} if settings.DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(settings.DATABASE_URL, echo=False, connect_args=connect_args)


def _now() -> datetime:
    return datetime.now(timezone.utc)


class User(SQLModel, table=True):
    __tablename__ = "users"

    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True, unique=True, max_length=64)
    email: str = Field(index=True, unique=True, max_length=255)
    full_name: Optional[str] = Field(default=None, max_length=128)
    # role: admin | architect | viewer
    role: str = Field(default="viewer", max_length=32)
    hashed_password: str = Field(sa_column=Column(Text, nullable=False))
    is_active: bool = Field(default=True)
    created_at: datetime = Field(default_factory=_now)


class Portfolio(SQLModel, table=True):
    """One portfolio document per user. `projects` is the JSON array the STAR
    frontend manages (projects -> assessments). Scoped strictly to its owner."""
    __tablename__ = "portfolios"

    user_id: int = Field(primary_key=True, foreign_key="users.id")
    projects: list = Field(default_factory=list, sa_column=Column(JSON, nullable=False))
    updated_at: datetime = Field(default_factory=_now)


def init_db() -> None:
    SQLModel.metadata.create_all(engine)


def get_session():
    with Session(engine) as session:
        yield session
