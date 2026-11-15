"""Request dependencies: the only way a handler reaches storage.

The chain is deliberate and short:

    request -> AppServices (process-wide) -> session -> user -> UserServices

`current_user` refuses a disabled account, `current_admin` refuses a non-admin,
and `user_services` builds (and caches on the request) the user scope. A handler
that declares `user: UserServices = Depends(user_services)` therefore cannot run
without an authenticated user, which is what the structural test enforces.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request, status

from app.auth.cookies import session_token
from app.auth.models import CurrentSession
from app.core.services import AppServices
from app.core.user_services import UserServices, build_user_services
from app.db.models import User

AUTH_SCHEME = "Session"


def get_app_services(request: Request) -> AppServices:
    services: AppServices = request.app.state.services
    return services


async def current_session(
    request: Request, app_services: AppServices = Depends(get_app_services)
) -> CurrentSession:
    resolved = await app_services.auth.resolve(session_token(request))
    if resolved is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": AUTH_SCHEME},
        )
    return resolved


async def current_user(session: CurrentSession = Depends(current_session)) -> User:
    return session.user


async def current_admin(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Administrator access required"
        )
    return user


async def user_services(
    request: Request,
    session: CurrentSession = Depends(current_session),
    app_services: AppServices = Depends(get_app_services),
) -> UserServices:
    """The authenticated user's scope, built once per request."""
    cached: UserServices | None = getattr(request.state, "user_services", None)
    if cached is not None and cached.user_id == session.user.id:
        return cached
    built = build_user_services(app_services, session.user)
    request.state.user_services = built
    return built


__all__ = [
    "current_admin",
    "current_session",
    "current_user",
    "get_app_services",
    "session_token",
    "user_services",
]
