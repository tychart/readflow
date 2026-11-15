"""The auth HTTP surface: status codes, cookies, CSRF and the route matrix.

The matrix test at the bottom enumerates **every** registered route, so a future
endpoint that forgets its auth dependency fails here rather than shipping open.
"""

from __future__ import annotations

import re

from fastapi.routing import APIRoute, APIWebSocketRoute
from httpx import ASGITransport, AsyncClient

from app.auth.cookies import COOKIE_NAME
from app.core.identity import DEFAULT_USER_PASSWORD, DEFAULT_USER_USERNAME

PASSWORD = DEFAULT_USER_PASSWORD
USERNAME = DEFAULT_USER_USERNAME

# Reachable without a session, by design. `/api/auth/logout` is deliberately
# idempotent: clearing a cookie somebody does not have is harmless, and a client
# whose session already expired must still be able to log out cleanly.
PUBLIC_PATHS = {
    "/health",
    "/api/auth/status",
    "/api/auth/setup",
    "/api/auth/login",
    "/api/auth/logout",
}


async def _fresh_client(app) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver")


async def test_status_reports_setup_and_authentication(anonymous_client) -> None:
    response = await anonymous_client.get("/api/auth/status")

    assert response.status_code == 200
    body = response.json()
    # The in-memory adapter seeds one development account, so setup is complete
    # and the caller is simply not logged in yet.
    assert body["needs_setup"] is False
    assert body["authenticated"] is False
    assert body["user"] is None


async def test_login_sets_a_hardened_session_cookie(anonymous_client) -> None:
    response = await anonymous_client.post(
        "/api/auth/login", json={"username": USERNAME, "password": PASSWORD}
    )

    assert response.status_code == 200
    cookie = response.headers["set-cookie"]
    assert f"{COOKIE_NAME}=" in cookie
    assert "HttpOnly" in cookie
    assert "SameSite=lax" in cookie.replace("samesite", "SameSite")
    # Plain HTTP in tests: Secure must not be set, or the browser would drop it.
    assert "Secure" not in cookie

    me = await anonymous_client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["username"] == USERNAME


async def test_the_cookie_is_secure_behind_a_https_proxy(anonymous_client) -> None:
    response = await anonymous_client.post(
        "/api/auth/login",
        json={"username": USERNAME, "password": PASSWORD},
        headers={"x-forwarded-proto": "https"},
    )

    assert response.status_code == 200
    assert "Secure" in response.headers["set-cookie"]


async def test_bad_credentials_are_generic_and_401(anonymous_client) -> None:
    unknown = await anonymous_client.post(
        "/api/auth/login", json={"username": "nobody", "password": PASSWORD}
    )
    wrong = await anonymous_client.post(
        "/api/auth/login", json={"username": USERNAME, "password": "wrong password"}
    )

    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json()["detail"] == wrong.json()["detail"] == "Invalid username or password"


async def test_repeated_failures_are_throttled(anonymous_client) -> None:
    for _ in range(5):
        response = await anonymous_client.post(
            "/api/auth/login", json={"username": USERNAME, "password": "wrong password"}
        )
        assert response.status_code == 401

    blocked = await anonymous_client.post(
        "/api/auth/login", json={"username": USERNAME, "password": PASSWORD}
    )

    assert blocked.status_code == 429
    assert "Retry-After" in blocked.headers


async def test_logout_clears_the_cookie_and_the_session(client) -> None:
    assert (await client.get("/api/auth/me")).status_code == 200

    response = await client.post("/api/auth/logout")

    assert response.status_code == 204
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_changing_the_password_requires_the_current_one(client) -> None:
    response = await client.post(
        "/api/auth/password",
        json={"current_password": "wrong", "new_password": "another long password"},
    )
    assert response.status_code == 400


async def test_a_short_new_password_is_rejected(client) -> None:
    response = await client.post(
        "/api/auth/password", json={"current_password": PASSWORD, "new_password": "short"}
    )
    assert response.status_code == 422


async def test_an_unknown_path_param_is_a_404_not_a_500(client) -> None:
    assert (await client.get("/api/jobs/does-not-exist")).status_code == 404
    assert (await client.get("/api/jobs/does-not-exist/chunks/init")).status_code == 404


async def test_a_cross_site_origin_is_refused(client) -> None:
    response = await client.post("/api/auth/logout", headers={"origin": "https://evil.example"})

    assert response.status_code == 403
    assert response.json()["detail"] == "Cross-origin request refused"


async def test_a_same_origin_request_is_allowed(client) -> None:
    response = await client.post(
        "/api/folders", json={"name": "Books"}, headers={"origin": "http://testserver"}
    )

    assert response.status_code == 201


async def test_a_missing_origin_is_allowed(client) -> None:
    """curl and the test suite send no Origin; SameSite=Lax is the defence there."""
    response = await client.post("/api/folders", json={"name": "No origin"})
    assert response.status_code == 201


# ── the whole-route matrix ──────────────────────────────────────────────────


def _concrete_path(route: APIRoute | APIWebSocketRoute) -> str:
    """Fill path params with a plausible value so the route can be called."""
    return re.sub(r"\{[^}]+\}", "probe-id", route.path)


async def test_every_non_public_route_requires_a_session(app, anonymous_client) -> None:
    """Generated from `app.routes`: a new endpoint cannot forget its auth check."""
    checked = 0
    for route in app.routes:
        if not isinstance(route, (APIRoute, APIWebSocketRoute)):
            continue
        path = _concrete_path(route)
        if path in PUBLIC_PATHS:
            continue
        methods = [method for method in getattr(route, "methods", set()) if method != "HEAD"]
        if not methods:
            # WebSocket routes have no methods; the handshake test covers them.
            continue
        for method in methods:
            response = await anonymous_client.request(
                method,
                path,
                json={} if method in {"POST", "PUT", "PATCH"} else None,
            )
            assert response.status_code in {401, 403, 422}, (
                f"{method} {path} did not require auth (got {response.status_code})"
            )
            assert response.status_code != 200, f"{method} {path} is open"
            checked += 1

    assert checked > 40, "the route matrix did not walk the app"


async def test_admin_routes_require_an_admin(app, services) -> None:
    """A normal user gets 403 on every /api/admin route."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as admin_client:
        login = await admin_client.post(
            "/api/auth/login", json={"username": USERNAME, "password": PASSWORD}
        )
        assert login.status_code == 200
        created = await admin_client.post(
            "/api/admin/users",
            json={"username": "reader", "password": "a reader password", "is_admin": False},
        )
        assert created.status_code == 201

    async with AsyncClient(transport=transport, base_url="http://testserver") as reader_client:
        login = await reader_client.post(
            "/api/auth/login", json={"username": "reader", "password": "a reader password"}
        )
        assert login.status_code == 200

        for path, method in [
            ("/api/admin/users", "GET"),
            ("/api/admin/config", "GET"),
            ("/api/admin/queue", "GET"),
            ("/api/admin/state", "GET"),
            ("/api/admin/backup", "GET"),
            ("/api/admin/model/evict", "POST"),
        ]:
            response = await reader_client.request(method, path)
            assert response.status_code == 403, f"{method} {path} let a non-admin in"


async def test_an_admin_route_is_reachable_by_an_admin(client) -> None:
    assert (await client.get("/api/admin/users")).status_code == 200
