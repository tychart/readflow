"""Per-request service scope.

Three scopes exist in this application, and they must not blur:

- **System scope** — the scheduler and the worker, constructed once at startup.
  They see every user's jobs because one GPU serves the whole machine.
- **User scope** — everything reachable from a request. Built here, bound to the
  authenticated user at construction, so a foreign id is indistinguishable from
  a missing one and a handler cannot accidentally query across users.
- **Content scope** — job source text and chunk text belong to their owner. Admin
  endpoints may read plumbing (status, counts, priority), never content.

`UserServices` is the whole user scope. Handlers depend on it, never on
`JobManager`/`LibraryService` directly, which is what makes the scope boundary a
type error to cross rather than a convention.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.services import AppServices
from app.db.models import User
from app.db.protocols import Database
from app.jobs.manager import JobManager
from app.library.progress_service import ProgressService
from app.library.service import LibraryService
from app.users.preferences import UserPreferencesService


@dataclass(slots=True)
class UserServices:
    user: User
    database: Database
    jobs: JobManager
    library: LibraryService
    progress: ProgressService
    preferences: UserPreferencesService

    @property
    def user_id(self) -> str:
        return self.user.id


def build_user_services(app_services: AppServices, user: User) -> UserServices:
    """Construct the user scope for one authenticated user.

    Cheap on purpose: the services are stateless wrappers around the shared
    database, so building them per request costs four object allocations.
    """
    database = app_services.database
    return UserServices(
        user=user,
        database=database,
        jobs=JobManager(database, user_id=user.id),
        library=LibraryService(database, user_id=user.id),
        progress=ProgressService(
            database,
            user_id=user.id,
            estimated_chars_per_second=app_services.settings.runtime.estimated_chars_per_second,
        ),
        preferences=UserPreferencesService(database, user_id=user.id),
    )
