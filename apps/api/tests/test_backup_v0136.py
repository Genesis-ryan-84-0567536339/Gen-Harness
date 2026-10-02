"""v0.1.36 (F-3): sao lưu theo lịch không chết âm thầm.

- Job lịch có timeout 3600 giây (mặc định arq 300 giây giết pg_dump giữa chừng).
- Bị huỷ (quá giờ / worker khởi động lại) ⇒ chuông "Sao lưu thất bại", khoá được nhả, tiến trình con bị giết.
"""

import asyncio
from typing import Any

import orjson
import pytest
from sqlalchemy import text

from gh import backup
from tests.conftest import Api
from tests.phase2 import org_id


def test_scheduled_backup_job_timeout_is_one_hour() -> None:
    assert backup.JOBS[0][1]["timeout"] == 3600
    from gh.worker import WorkerSettings

    [job] = [c for c in WorkerSettings.cron_jobs if c.name == "cron:scheduled_backup_scan"]
    assert job.timeout_s == 3600


async def test_scheduled_scan_cancelled_notifies_and_releases_lock(app, db, redis,  # type: ignore[no-untyped-def]
                                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    org = await org_id(db)
    await db.execute(text("""UPDATE core.organizations SET settings = settings ||
                             '{"backup": {"frequency": "daily", "time_of_day": "02:00"}}'::jsonb WHERE id = :o"""),
                     {"o": org})
    await db.commit()
    calls: list[dict[str, Any]] = []

    async def no_backups(**_: Any) -> list[Any]:
        return []

    async def cancelled(**_: Any) -> Any:
        raise asyncio.CancelledError

    async def record(redis_: Any, *, ok: bool, message: str) -> None:
        calls.append({"ok": ok, "message": message})

    monkeypatch.setattr(backup, "list_backups", no_backups)
    monkeypatch.setattr(backup, "is_due", lambda *a, **k: True)
    monkeypatch.setattr(backup, "run_backup", cancelled)
    monkeypatch.setattr(backup, "_notify_owners", record)
    with pytest.raises(asyncio.CancelledError):
        await backup.scheduled_backup_scan({"redis": redis})
    assert calls == [{"ok": False, "message": backup.CANCELLED_SCHEDULED_MESSAGE}]
    assert "Sao lưu ngay" in calls[0]["message"]
    assert not await redis.exists(backup.LOCK_KEY)


async def test_run_kills_child_process_when_cancelled(monkeypatch: pytest.MonkeyPatch) -> None:
    procs: list[Any] = []
    real = asyncio.create_subprocess_exec

    async def spy(*args: Any, **kw: Any) -> Any:
        proc = await real(*args, **kw)
        procs.append(proc)
        return proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spy)
    task = asyncio.create_task(backup._run(["sleep", "30"]))
    for _ in range(50):
        if procs:
            break
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert procs and procs[0].returncode is not None  # đã chết — không mồ côi


async def test_backup_now_cancelled_marks_failed_and_rings(owner_api: Api, db, redis,  # type: ignore[no-untyped-def]
                                                           monkeypatch: pytest.MonkeyPatch) -> None:
    async def cancelled(**_: Any) -> Any:
        raise asyncio.CancelledError

    monkeypatch.setattr(backup, "run_backup", cancelled)
    with pytest.raises(asyncio.CancelledError):
        await backup.backup_now({"redis": redis})
    job = orjson.loads(await redis.get(backup.JOB_KEY))
    assert job["state"] == "failed" and job["message"] == "Sao lưu bị dừng giữa chừng"
    assert not await redis.exists(backup.LOCK_KEY)
    await db.commit()
    rows = (await db.execute(text("SELECT title, body, link FROM core.notifications WHERE kind = 'backup.failed'"))
            ).all()
    assert len(rows) == 1
    assert rows[0].title == "Sao lưu thất bại" and rows[0].link == "/system?tab=storage"
    assert rows[0].body.startswith("Sao lưu bị dừng giữa chừng")
