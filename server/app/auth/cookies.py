"""The session cookie, and nothing else.

Flags, and why each one:

- `HttpOnly`: JavaScript never needs it, and an XSS bug must not be able to
  steal a 30-day session.
- `SameSite=Lax`: the primary CSRF defence; the Origin check is the second.
- `Path=/`: the reader loads `/api/jobs/...` chunk URLs directly.
- `Secure` when the request arrived over HTTPS (or `READFLOW_COOKIE_SECURE=always`),
  determined from the actual request/proxy header rather than a hardcoded flag, so
  the same image works behind Caddy and on plain-HTTP localhost.
"""

from __future__ import annotations

from fastapi import Request, Response
from starlette.requests import HTTPConnection

from app.core.config import Settings

COOKIE_NAME = "readflow_session"


def request_is_https(request: Request, settings: Settings) -> bool:
    mode = settings.cookie_secure
    if mode == "always":
        return True
    if mode == "never":
        return False
    forwarded = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return request.url.scheme == "https" or forwarded == "https"


def set_session_cookie(
    response: Response, token: str, *, request: Request, settings: Settings
) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=int(settings.session_absolute_seconds),
        httponly=True,
        samesite="lax",
        secure=request_is_https(request, settings),
        path="/",
    )


def clear_session_cookie(response: Response, *, request: Request, settings: Settings) -> None:
    response.delete_cookie(
        key=COOKIE_NAME,
        httponly=True,
        samesite="lax",
        secure=request_is_https(request, settings),
        path="/",
    )


def session_token(connection: HTTPConnection) -> str | None:
    """The presented session token, from an HTTP request or a WebSocket handshake."""
    return connection.cookies.get(COOKIE_NAME)


__all__ = [
    "COOKIE_NAME",
    "clear_session_cookie",
    "request_is_https",
    "session_token",
    "set_session_cookie",
]
