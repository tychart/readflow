"""Stable identity values shared by the domain models and the storage layer.

They live outside both so neither has to import the other just for a constant.
When real authentication arrives, `DEFAULT_USER_ID` stops being the only user,
but every stored row already carries a `user_id`.
"""

from __future__ import annotations

DEFAULT_USER_ID = "local"
DEFAULT_USER_DISPLAY_NAME = "Local user"
