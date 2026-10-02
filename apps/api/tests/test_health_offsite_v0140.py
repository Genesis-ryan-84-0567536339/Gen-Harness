"""v0.1.40 (F-12): chuông offsite.stale / offsite.failed trong dải "Cần Sếp xử lý" + khối 'offsite' của /system/health.

- Chỉ khi có hộp thư với genh (run/); không có ⇒ khuôn /system/health cũ (test_health_v0136 kiểm set(body)).
- Chuông khử trùng lặp: chạy lại vòng theo dõi không sinh chuông thứ hai; đổi mức (warn → bad) mới có chuông mới.
"""

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text

from gh import health
from gh.config import get_settings
from gh.db import sessionmaker
from tests.conftest import Api
from tests.phase2 import org_id


@pytest.fixture
def link(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    d = tmp_path / "run"
    (d / "request").mkdir(parents=True)
    (d / "genh.json").write_text(json.dumps({"version": "v0.1.40", "updater": "systemd",
                                             "requests": ["update", "restore", "offsite"]}))
    monkeypatch.setenv("GH_HOST_LINK_DIR", str(d))
    get_settings.cache_clear()
    yield d
    get_settings.cache_clear()


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _status(d: Path, **kw: Any) -> None:
    base = {"schema": 1, "configured": True, "dest": "/media/usb", "state": "ok", "error_code": "",
            "last_attempt_at": "", "last_success_at": "", "last_file": "", "last_size_bytes": 0, "verified": True,
            "kept": 1, "schedule": "systemd", "key_id": "0badc0de"}
    (d / "offsite-status.json").write_text(json.dumps({**base, **kw}))


async def _evaluate(redis: Any, org: Any, now: datetime | None = None) -> None:
    now = now or datetime.now(UTC)
    async with sessionmaker()() as s:
        await health.evaluate(s, redis, org, now=now, started_at=now)
        await s.commit()


async def _alerts(db: Any, kind: str) -> list[Any]:
    await db.commit()
    return list((await db.execute(text("""SELECT key, severity, title, body, link, cleared_at FROM ops.health_alerts
                                          WHERE kind = :k"""), {"k": kind})).all())


async def _bells(db: Any, kind: str) -> list[Any]:
    await db.commit()
    return list((await db.execute(text("SELECT title, body, link FROM core.notifications WHERE kind = :k"),
                                  {"k": kind})).all())


async def _age_org(db: Any, org: Any, days: int) -> None:
    await db.execute(text("UPDATE core.organizations SET created_at = now() - make_interval(days => :d) WHERE id = :o"),
                     {"d": days, "o": org})
    await db.commit()


async def test_stale_8_days_rings_once_then_bad_after_30_then_clears(owner_api: Api, link: Path, db, redis) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    now = datetime.now(UTC)
    _status(link, last_attempt_at=_iso(now - timedelta(days=8)), last_success_at=_iso(now - timedelta(days=8)))
    await _evaluate(redis, org)
    [row] = await _alerts(db, "offsite.stale")
    assert row.key == "offsite.stale" and row.severity == "warn" and row.cleared_at is None
    assert row.title == "Bản sao ngoài máy đã cũ 8 ngày"
    assert row.link == health.OFFSITE_LINK == "/system?tab=storage&focus=offsite"
    assert len(await _bells(db, "offsite.stale")) == 1
    # chạy lại (kể cả qua ngày) ⇒ không chuông thứ hai
    await _evaluate(redis, org)
    await _evaluate(redis, org, now + timedelta(days=1))
    assert len(await _bells(db, "offsite.stale")) == 1
    [row] = await _alerts(db, "offsite.stale")
    assert row.title == "Bản sao ngoài máy đã cũ 9 ngày"

    # 31 ngày ⇒ 'bad' (mức đổi ⇒ một chuông mới)
    _status(link, last_attempt_at=_iso(now - timedelta(days=31)), last_success_at=_iso(now - timedelta(days=31)))
    await _evaluate(redis, org)
    [row] = await _alerts(db, "offsite.stale")
    assert row.severity == "bad"
    assert len(await _bells(db, "offsite.stale")) == 2
    await _evaluate(redis, org)
    assert len(await _bells(db, "offsite.stale")) == 2

    # bản mới ⇒ đóng sự cố
    _status(link, last_attempt_at=_iso(now), last_success_at=_iso(now))
    await _evaluate(redis, org)
    [row] = await _alerts(db, "offsite.stale")
    assert row.cleared_at is not None
    assert [i for i in await health.active_issues(db, org) if i["kind"].startswith("offsite")] == []


async def test_not_mounted_rings_failed_with_friendly_body(owner_api: Api, link: Path, db, redis) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    now = datetime.now(UTC)
    _status(link, state="not_mounted", error_code="GH-EB01", last_attempt_at=_iso(now - timedelta(hours=1)),
            last_success_at=_iso(now - timedelta(days=2)))
    await _evaluate(redis, org)
    [row] = await _alerts(db, "offsite.failed")
    assert row.severity == "warn" and row.cleared_at is None
    assert row.body.startswith("Chưa thấy ổ USB/NAS")
    await _evaluate(redis, org)
    assert len(await _bells(db, "offsite.failed")) == 1
    # chưa cũ ⇒ không offsite.stale
    assert await _alerts(db, "offsite.stale") == []

    # lần thử khác lỗi khác (GH-EB03) ⇒ fingerprint mới ⇒ chuông mới, thân theo mã
    _status(link, state="failed", error_code="GH-EB03", last_attempt_at=_iso(now),
            last_success_at=_iso(now - timedelta(days=2)))
    await _evaluate(redis, org)
    [row] = await _alerts(db, "offsite.failed")
    assert row.body.startswith("Bản sao vừa tạo không đọc lại được — chưa có bản sao ngoài máy")
    assert len(await _bells(db, "offsite.failed")) == 2

    # thành công sau đó ⇒ đóng
    _status(link, state="ok", last_attempt_at=_iso(now + timedelta(minutes=5)),
            last_success_at=_iso(now + timedelta(minutes=5)))
    await _evaluate(redis, org, now + timedelta(minutes=6))
    [row] = await _alerts(db, "offsite.failed")
    assert row.cleared_at is not None


async def test_unknown_error_code_uses_fixed_body(owner_api: Api, link: Path, db, redis) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    now = datetime.now(UTC)
    _status(link, state="failed", error_code="Chữ lạ <b>", last_attempt_at=_iso(now),
            last_success_at=_iso(now - timedelta(days=1)))
    await _evaluate(redis, org)
    [row] = await _alerts(db, "offsite.failed")
    assert row.body == health.OFFSITE_FAILED_GENERIC
    assert "Chữ lạ" not in row.title + row.body


async def test_not_configured_new_org_no_alert_old_org_warns(owner_api: Api, link: Path, db, redis) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    await _evaluate(redis, org)  # không có offsite-status.json, tổ chức vừa tạo
    assert await _alerts(db, "offsite.stale") == []
    assert await _bells(db, "offsite.stale") == []
    body = (await owner_api.get("/system/health")).json()
    assert body["offsite"]["stale"] is False and body["offsite"]["configured"] is False

    await _age_org(db, org, 8)
    await _evaluate(redis, org)
    [row] = await _alerts(db, "offsite.stale")
    assert row.title == "Chưa có bản sao ngoài máy" and row.severity == "warn"
    assert row.body == ("Hỏng ổ đĩa là mất hết dữ liệu. Cắm ổ USB hoặc chọn thư mục NAS rồi bấm "
                        "'Chọn nơi lưu bản sao ngoài máy'")
    await _evaluate(redis, org)
    assert len(await _bells(db, "offsite.stale")) == 1


async def test_system_health_offsite_block_and_actions(owner_api: Api, link: Path, db, redis) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    now = datetime.now(UTC)
    _status(link, state="not_mounted", error_code="GH-EB01", last_attempt_at=_iso(now),
            last_success_at=_iso(now - timedelta(days=10)))
    await _evaluate(redis, org)
    body = (await owner_api.get("/system/health")).json()
    assert body["offsite"] == {"state": "not_mounted", "configured": True,
                               "last_success_at": _iso(now - timedelta(days=10)), "age_days": 10, "stale": True,
                               "error_code": "GH-EB01", "schedule": "systemd"}
    assert body["overall"] in ("warn", "bad")
    actions = {i["kind"]: i["action"] for i in body["issues"]}
    assert actions["offsite.stale"] == health.ACTIONS["offsite.stale"] == "Chọn nơi lưu / sao lưu ngay"
    assert actions["offsite.failed"] == health.ACTIONS["offsite.failed"] == "Xem bản sao ngoài máy"
    assert health.ACTIONS["job.timeout"] == "Xem sức khoẻ"


async def test_stale_offsite_only_warns_overall(owner_api: Api, link: Path, db, redis) -> None:  # type: ignore[no-untyped-def]
    """Không có sự cố nào khác: bản sao ngoài máy cũ chỉ kéo 'overall' xuống 'warn', không 'bad'."""
    now = datetime.now(UTC)
    _status(link, last_attempt_at=_iso(now - timedelta(days=40)), last_success_at=_iso(now - timedelta(days=40)))
    await redis.set(health.HEARTBEAT_KEY, _iso(now))
    body = (await owner_api.get("/system/health")).json()
    assert body["offsite"]["stale"] is True
    assert body["overall"] == "warn"


async def test_no_host_link_keeps_old_shape(owner_api: Api, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                            db, redis) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("GH_HOST_LINK_DIR", str(tmp_path / "khong-co"))
    get_settings.cache_clear()
    org = await org_id(db)
    await _age_org(db, org, 40)
    await _evaluate(redis, org)
    body = (await owner_api.get("/system/health")).json()
    get_settings.cache_clear()
    assert "offsite" not in body
    assert await _alerts(db, "offsite.stale") == []
