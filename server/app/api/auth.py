"""Authentication HTTP surface.

The routes are thin: parse, call `AuthService`, set or clear the cookie. Every
security decision (hashing, throttling, rotation, revocation) lives in
`app.auth.service`, and the only HTTP-specific knowledge here is status codes and
the cookie.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from app.api.deps import current_session, get_app_services
from app.auth.cookies import (
    clear_session_cookie,
    session_token,
    set_session_cookie,
)
from app.auth.models import AuthError, CurrentSession, SetupAlreadyCompleteError
from app.auth.passwords import PasswordError
from app.auth.throttle import RateLimitedError
from app.core.services import AppServices
from app.schemas.auth import (
    AuthStatusResponse,
    ChangePasswordRequest,
    LoginRequest,
    SetupRequest,
    UserResponse,
    user_response,
)


class AuthRouter:
    """Builds the auth router (a class so the handlers stay small)."""

    def __init__(self) -> None:
        self.router = APIRouter(prefix="/auth", tags=["auth"])
        self._register()

    def _register(self) -> None:
        router = self.router

        @router.get("/status", response_model=AuthStatusResponse)
        async def auth_status(
            request: Request, app_services: AppServices = Depends(get_app_services)
        ) -> AuthStatusResponse:
            """Public: tells the client whether to show setup, login, or the app."""
            needs_setup = not await app_services.auth.is_setup_complete()
            resolved = await app_services.auth.resolve(session_token(request))
            return AuthStatusResponse(
                needs_setup=needs_setup,
                authenticated=resolved is not None,
                user=user_response(resolved.user) if resolved is not None else None,
            )

        @router.post("/setup", response_model=AuthStatusResponse, status_code=201)
        async def setup(
            request: Request,
            response: Response,
            payload: SetupRequest,
            app_services: AppServices = Depends(get_app_services),
        ) -> AuthStatusResponse:
            """Create the first account. Only possible on an empty install."""
            try:
                user = await app_services.auth.setup_first_admin(
                    username=payload.username,
                    password=payload.password,
                    display_name=payload.display_name,
                )
            except SetupAlreadyCompleteError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            except (AuthError, PasswordError) as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            token, user = await app_services.auth.login(
                payload.username, payload.password, client_key=_client_key(request)
            )
            set_session_cookie(response, token, request=request, settings=app_services.settings)
            result = AuthStatusResponse(
                needs_setup=False, authenticated=True, user=user_response(user)
            )
            response.status_code = status.HTTP_201_CREATED
            return result

        @router.post("/login", response_model=AuthStatusResponse)
        async def login(
            request: Request,
            response: Response,
            payload: LoginRequest,
            app_services: AppServices = Depends(get_app_services),
        ) -> AuthStatusResponse:
            try:
                token, user = await app_services.auth.login(
                    payload.username,
                    payload.password,
                    client_key=_client_key(request),
                    previous_token=session_token(request),
                )
            except RateLimitedError as exc:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Too many failed attempts",
                    headers={"Retry-After": str(int(exc.retry_after) + 1)},
                ) from exc
            except AuthError as exc:
                # Deliberately generic: never reveal whether the user exists.
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid username or password",
                ) from exc
            set_session_cookie(response, token, request=request, settings=app_services.settings)
            return AuthStatusResponse(
                needs_setup=False, authenticated=True, user=user_response(user)
            )

        @router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
        async def logout(
            request: Request,
            response: Response,
            app_services: AppServices = Depends(get_app_services),
        ) -> None:
            """Idempotent: clears the cookie and deletes the session row."""
            await app_services.auth.logout(session_token(request))
            clear_session_cookie(response, request=request, settings=app_services.settings)

        @router.get("/me", response_model=UserResponse)
        async def me(session: CurrentSession = Depends(current_session)) -> UserResponse:
            return user_response(session.user)

        @router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
        async def change_password(
            payload: ChangePasswordRequest,
            session: CurrentSession = Depends(current_session),
            app_services: AppServices = Depends(get_app_services),
        ) -> None:
            """Change the password and revoke every *other* session."""
            try:
                await app_services.auth.change_password(
                    session.user.id,
                    current_password=payload.current_password,
                    new_password=payload.new_password,
                    keep_session_id=session.session.id,
                )
            except PasswordError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except AuthError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc


def _client_key(request: Request) -> str:
    """Throttle key: the proxy-aware client address, not the socket's."""
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    if forwarded:
        return forwarded
    return request.client.host if request.client else "unknown"


def build_auth_router() -> APIRouter:
    return AuthRouter().router


__all__ = ["build_auth_router"]
