from __future__ import annotations

from pathlib import Path

import psutil
from pydantic import BaseModel

MIB = 1024 * 1024
CGROUP_ROOT = Path("/sys/fs/cgroup")


class MemoryStats(BaseModel):
    """All sizes are MiB, despite the historical API's `_mb` suffix.

    RAM usage excludes reclaimable cache (total minus available). Process RAM
    is the API server's RSS, not a sum of child/shared resident pages. GPU usage
    is device-wide on CUDA device 0 (CUDA-usable capacity, excluding memory
    reserved by the driver/firmware); PyTorch's allocator figures are separate
    and do not include CUDA context/driver or non-PyTorch allocations.
    """

    device: str
    vram_total_mb: int | None = None
    vram_used_mb: int | None = None
    vram_free_mb: int | None = None
    vram_allocated_mb: int | None = None
    vram_reserved_mb: int | None = None
    ram_total_mb: int
    ram_available_mb: int
    ram_used_mb: int
    ram_process_mb: int
    # A container's budget is not the host's capacity. Keep it separate; cgroup
    # usage includes cache and is not comparable to process RSS.
    ram_cgroup_used_mb: int | None = None
    ram_cgroup_limit_mb: int | None = None


def _cgroup_memory(total_bytes: int) -> tuple[int | None, int | None]:
    """Read the visible cgroup budget (Docker/Podman's namespaced cgroup root).

    Both cgroup v2 and the standard v1 memory-controller mount are supported.
    No host mounts/privileges are needed. Missing/denied files, v2's `max`, and
    v1's enormous unlimited sentinel mean no known tighter container budget.
    """
    for limit_path, used_path in (
        (CGROUP_ROOT / "memory.max", CGROUP_ROOT / "memory.current"),
        (
            CGROUP_ROOT / "memory/memory.limit_in_bytes",
            CGROUP_ROOT / "memory/memory.usage_in_bytes",
        ),
    ):
        try:
            limit = int(limit_path.read_text().strip())
            if not 0 < limit < total_bytes:
                continue
        except (OSError, ValueError):
            continue
        try:
            used = int(used_path.read_text().strip()) // MIB
        except (OSError, ValueError):
            used = None
        return used, limit // MIB
    return None, None


def system_memory_stats(*, device: str = "cpu") -> MemoryStats:
    memory = psutil.virtual_memory()
    total = memory.total // MIB
    available = memory.available // MIB
    cgroup_used, cgroup_limit = _cgroup_memory(memory.total)
    return MemoryStats(
        device=device,
        ram_total_mb=total,
        ram_available_mb=available,
        ram_used_mb=total - available,
        ram_process_mb=psutil.Process().memory_info().rss // MIB,
        ram_cgroup_used_mb=cgroup_used,
        ram_cgroup_limit_mb=cgroup_limit,
    )
