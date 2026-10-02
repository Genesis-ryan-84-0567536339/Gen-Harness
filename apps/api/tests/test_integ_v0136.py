"""v0.1.36 — kiểm tích hợp hai gói: worker ghi dấu cron/nhịp tim (gh/worker.py `_tracked`, gói lich-phien-ban-log) và
API đọc lại đúng hợp đồng Redis đó cho `GET /system/health` (gh/health.py, gói api-tu-bao-sao-luu)."""

from typing import Any

import pytest

from gh import health, worker
from tests.conftest import Api


def test_redis_contract_keys_match() -> None:
    assert worker.HEARTBEAT_KEY == health.HEARTBEAT_KEY
    assert worker.CRON_LAST_KEY.format("x") == f"{health.CRON_LAST_PREFIX}x"


async def test_tracked_cron_shows_up_in_system_health(owner_api: Api, redis: Any) -> None:
    async def scheduled_backup_scan(ctx: dict[str, Any]) -> None:
        return None

    async def broken_job(ctx: dict[str, Any]) -> None:
        raise RuntimeError("hỏng cố ý")

    await worker._tracked(scheduled_backup_scan)({"redis": redis})
    with pytest.raises(RuntimeError):
        await worker._tracked(broken_job)({"redis": redis})

    r = await owner_api.get("/system/health")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["worker"]["state"] == "ok" and isinstance(body["worker"]["last_seen_at"], str)
    crons = {c["name"]: c for c in body["crons"]}
    assert crons["scheduled_backup_scan"]["ok"] is True and isinstance(crons["scheduled_backup_scan"]["last_at"], str)
    assert crons["broken_job"]["ok"] is False
    assert body["overall"] in ("warn", "bad")  # cron lỗi ⇒ ít nhất 'warn'
