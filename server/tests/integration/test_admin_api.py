"""Admin user management and the backup endpoint."""

from __future__ import annotations

from httpx import ASGITransport, AsyncClient

NEW_USER_PASSWORD = "a reader password"


async def _client_for(app, username: str, password: str) -> AsyncClient:
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver")
    response = await client.post(
        "/api/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200, response.text
    return client


async def test_listing_users_never_leaks_hashes(client) -> None:
    response = await client.get("/api/admin/users")

    assert response.status_code == 200
    users = response.json()["users"]
    assert users
    for user in users:
        assert "password_hash" not in user
        assert "password" not in user


async def test_creating_a_user_and_logging_in_as_them(app, client) -> None:
    created = await client.post(
        "/api/admin/users",
        json={"username": "reader", "password": NEW_USER_PASSWORD, "display_name": "Reader"},
    )

    assert created.status_code == 201
    body = created.json()
    assert body["username"] == "reader"
    assert body["is_admin"] is False
    assert "password" not in body

    reader_client = await _client_for(app, "reader", NEW_USER_PASSWORD)
    try:
        me = await reader_client.get("/api/auth/me")
        assert me.status_code == 200
        assert me.json()["display_name"] == "Reader"
    finally:
        await reader_client.aclose()


async def test_a_duplicate_username_is_rejected(client) -> None:
    response = await client.post(
        "/api/admin/users", json={"username": "reader", "password": NEW_USER_PASSWORD}
    )
    assert response.status_code == 201
    duplicate = await client.post(
        "/api/admin/users", json={"username": "READER", "password": NEW_USER_PASSWORD}
    )
    assert duplicate.status_code == 400


async def test_a_short_password_is_rejected_by_the_schema(client) -> None:
    response = await client.post(
        "/api/admin/users", json={"username": "shorty", "password": "too short"}
    )
    assert response.status_code == 422


async def test_disabling_a_user_revokes_their_live_session(app, client) -> None:
    created = await client.post(
        "/api/admin/users", json={"username": "reader", "password": NEW_USER_PASSWORD}
    )
    user_id = created.json()["id"]
    reader_client = await _client_for(app, "reader", NEW_USER_PASSWORD)
    try:
        assert (await reader_client.get("/api/auth/me")).status_code == 200

        disabled = await client.patch(f"/api/admin/users/{user_id}", json={"is_active": False})
        assert disabled.status_code == 200
        assert disabled.json()["is_active"] is False

        assert (await reader_client.get("/api/auth/me")).status_code == 401
        blocked = await reader_client.post(
            "/api/auth/login", json={"username": "reader", "password": NEW_USER_PASSWORD}
        )
        assert blocked.status_code == 401
    finally:
        await reader_client.aclose()


async def test_resetting_a_password_revokes_sessions_and_accepts_the_new_one(app, client) -> None:
    created = await client.post(
        "/api/admin/users", json={"username": "reader", "password": NEW_USER_PASSWORD}
    )
    user_id = created.json()["id"]
    reader_client = await _client_for(app, "reader", NEW_USER_PASSWORD)
    try:
        updated = await client.patch(
            f"/api/admin/users/{user_id}", json={"password": "a brand new password"}
        )
        assert updated.status_code == 200
        assert (await reader_client.get("/api/auth/me")).status_code == 401
    finally:
        await reader_client.aclose()

    fresh = await _client_for(app, "reader", "a brand new password")
    await fresh.aclose()


async def test_an_unknown_user_id_is_a_400(client) -> None:
    response = await client.patch("/api/admin/users/does-not-exist", json={"is_active": False})
    assert response.status_code == 400


async def test_an_unknown_field_is_rejected(client) -> None:
    response = await client.patch("/api/admin/users/someone", json={"is_adminn": True})
    assert response.status_code == 422


async def test_the_backup_endpoint_needs_a_database(client, services) -> None:
    """The in-memory adapter has nothing to dump, and says so."""
    response = await client.get("/api/admin/backup")

    assert response.status_code == 503
    assert "database" in response.json()["detail"].lower()
