"""FastAPI dependencies for authentication and role-based authorization.

`get_current_user` validates the bearer JWT and loads the active user.
`require_role` builds a dependency that enforces an RBAC tier.
"""
from typing import Callable

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlmodel import Session, select

from app.core.config import settings
from app.core.security import decode_access_token
from app.db.models import User, get_session

oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_PREFIX}/auth/login")

_CREDENTIALS_EXC = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Could not validate credentials",
    headers={"WWW-Authenticate": "Bearer"},
)

# role hierarchy — higher number grants everything below it
_ROLE_RANK = {"viewer": 1, "architect": 2, "admin": 3}


def get_current_user(
    token: str = Depends(oauth2_scheme),
    session: Session = Depends(get_session),
) -> User:
    payload = decode_access_token(token)
    if not payload or not payload.get("sub"):
        raise _CREDENTIALS_EXC
    user = session.exec(select(User).where(User.username == payload["sub"])).first()
    if not user or not user.is_active:
        raise _CREDENTIALS_EXC
    return user


def require_role(minimum: str) -> Callable[..., User]:
    """Return a dependency that requires at least `minimum` role."""
    min_rank = _ROLE_RANK.get(minimum, 99)

    def _checker(user: User = Depends(get_current_user)) -> User:
        if _ROLE_RANK.get(user.role, 0) < min_rank:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires '{minimum}' role or higher",
            )
        return user

    return _checker
