from types import SimpleNamespace

import pytest

from app.telemetry.memory import MIB, system_memory_stats


def test_ram_distinguishes_system_pressure_from_server_rss(monkeypatch):
    monkeypatch.setattr(
        "app.telemetry.memory.psutil.virtual_memory",
        lambda: SimpleNamespace(total=65536 * MIB, available=31744 * MIB, used=999 * MIB),
    )
    monkeypatch.setattr(
        "app.telemetry.memory.psutil.Process",
        lambda: SimpleNamespace(memory_info=lambda: SimpleNamespace(rss=2048 * MIB)),
    )

    stats = system_memory_stats()

    assert stats.ram_total_mb == 65536
    assert stats.ram_available_mb == 31744
    assert stats.ram_used_mb == 33792  # 33 GiB system-wide, not the server's 2 GiB.
    assert stats.ram_process_mb == 2048
    assert stats.vram_total_mb is None


@pytest.mark.parametrize(
    ("limit_path", "used_path"),
    [
        ("memory.max", "memory.current"),
        ("memory/memory.limit_in_bytes", "memory/memory.usage_in_bytes"),
    ],
)
def test_container_budget_is_separate_from_host_ram(monkeypatch, tmp_path, limit_path, used_path):
    from app.telemetry.memory import _cgroup_memory

    monkeypatch.setattr("app.telemetry.memory.CGROUP_ROOT", tmp_path)
    limit = tmp_path / limit_path
    limit.parent.mkdir(parents=True, exist_ok=True)
    limit.write_text(str(4 * 1024 * MIB))
    (tmp_path / used_path).write_text(str(2 * 1024 * MIB))

    assert _cgroup_memory(64 * 1024 * MIB) == (2048, 4096)


@pytest.mark.parametrize("limit", ["max", str(2**63 - 4096), "not-a-number", "0", "-1"])
def test_unlimited_or_invalid_cgroup_is_not_a_host_capacity(monkeypatch, tmp_path, limit):
    from app.telemetry.memory import _cgroup_memory

    monkeypatch.setattr("app.telemetry.memory.CGROUP_ROOT", tmp_path)
    (tmp_path / "memory.max").write_text(limit)
    (tmp_path / "memory.current").write_text(str(1024 * MIB))

    assert _cgroup_memory(64 * 1024 * MIB) == (None, None)


def test_missing_cgroup_files_are_supported(monkeypatch, tmp_path):
    from app.telemetry.memory import _cgroup_memory

    monkeypatch.setattr("app.telemetry.memory.CGROUP_ROOT", tmp_path)
    assert _cgroup_memory(64 * 1024 * MIB) == (None, None)


def test_cgroup_limit_survives_an_unreadable_usage_file(monkeypatch, tmp_path):
    from app.telemetry.memory import _cgroup_memory

    monkeypatch.setattr("app.telemetry.memory.CGROUP_ROOT", tmp_path)
    (tmp_path / "memory.max").write_text(str(4 * 1024 * MIB))

    assert _cgroup_memory(64 * 1024 * MIB) == (None, 4096)
