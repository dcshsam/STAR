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


def _seed_admin() -> None:
    with Session(engine) as session:
        if session.exec(select(User)).first():
            return
        admin = User(
            username=settings.FIRST_ADMIN_USERNAME,
            email=settings.FIRST_ADMIN_EMAIL,
            full_name="Bootstrap Admin",
            role="admin",
            hashed_password=hash_password(settings.FIRST_ADMIN_PASSWORD),
        )
        session.add(admin)
        session.commit()
        logger.info("Seeded bootstrap admin user '%s' — change the password immediately.",
                    settings.FIRST_ADMIN_USERNAME)


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
