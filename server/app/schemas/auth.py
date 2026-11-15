"""Auth payloads. `snake_case`, no password ever leaves the server."""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.core.time import to_iso
from app.db.models import User


class UserResponse(BaseModel):
    id: str
    username: str
    display_name: str
    is_admin: bool
    is_active: bool = True
    # ISO-8601 instant with an explicit `Z`.
    created_at: str


def user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        is_admin=user.is_admin,
        is_active=user.is_active,
        created_at=to_iso(user.created_at),
    )


class AuthStatusResponse(BaseModel):
    """Public bootstrap state: what the client should render."""

    needs_setup: bool
    authenticated: bool
    user: UserResponse | None = None


class SetupRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=12, max_length=1024)
    display_name: str | None = Field(default=None, max_length=120)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=1024)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=12, max_length=1024)


class UserListResponse(BaseModel):
    users: list[UserResponse]


class UserCreateRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=12, max_length=1024)
    display_name: str | None = Field(default=None, max_length=120)
    is_admin: bool = False


class UserUpdateRequest(BaseModel):
    # Admin knobs have near-identical shapes; a typo should be a 422, not a
    # silently ignored field.
    model_config = {"extra": "forbid"}

    is_active: bool | None = None
    is_admin: bool | None = None
    display_name: str | None = Field(default=None, max_length=120)
    password: str | None = Field(default=None, min_length=12, max_length=1024)
