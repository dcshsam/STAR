"""STAR backend — FastAPI application entrypoint.

Wires the routers, configures CORS, adds baseline security headers, creates
tables on startup, and seeds a bootstrap admin if the user table is empty.
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select

from app.api import auth as auth_routes
from app.api import star as star_routes
from app.core.config import settings
from app.core.security import hash_password
from app.db.models import User, engine, init_db

logger = logging.getLogger("star")
logging.basicConfig(level=logging.INFO)


def _ensure_user(session: Session, username: str, email: str, full_name: str,
                  role: str, password: str) -> None:
    from sqlmodel import select as _sel
    if not session.exec(_sel(User).where(User.username == username)).first():
        session.add(User(username=username, email=email, full_name=full_name,
                         role=role, hashed_password=hash_password(password)))
        logger.info("Seeded user '%s' (role=%s).", username, role)


def _seed_admin() -> None:
    with Session(engine) as session:
        _ensure_user(session,
                     settings.FIRST_ADMIN_USERNAME,
                     settings.FIRST_ADMIN_EMAIL,
                     "Bootstrap Admin", "admin",
                     settings.FIRST_ADMIN_PASSWORD)
        # Seed the demo architect so the frontend default creds work with real auth.
        _ensure_user(session,
                     "architect", "architect@example.com",
                     "Demo Architect", "architect",
                     "star2026")
        session.commit()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    _seed_admin()
    if settings.SECRET_KEY.startswith("dev-only") and settings.is_production:
        logger.warning("SECRET_KEY is the insecure dev default in a production env — set a real one!")
    yield


app = FastAPI(title=settings.APP_NAME, version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    # On BTP the approuter terminates TLS; HSTS is appropriate behind HTTPS.
    if settings.is_production:
        resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return resp


@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok", "app": settings.APP_NAME, "env": settings.ENV}


app.include_router(auth_routes.router, prefix=settings.API_PREFIX)
app.include_router(star_routes.router, prefix=settings.API_PREFIX)
