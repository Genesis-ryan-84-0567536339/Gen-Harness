"""Nút "Cập nhật ngay" trong Console: api chỉ để lại yêu cầu trong hộp thư chung với genh trên máy chủ
(apps/genh/internal/hostlink) và đọc lại tiến trình — không tự nâng cấp chính nó."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from gh.config import get_settings
from gh.system_api import update as upd
from tests.conftest import Api
from tests.test_rbac_api import login_as


def test_is_newer() -> None:
    assert upd.is_newer("v0.1.17", "v0.1.16")
    assert upd.is_newer("v0.2.0", "v0.1.99")
    assert not upd.is_newer("v0.1.16", "v0.1.16")
    assert not upd.is_newer("v0.1.15", "v0.1.16")
    assert not upd.is_newer("v0.1.17", "dev") and not upd.is_newer(None, "v0.1.16")


@pytest.fixture
def link(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, redis) -> Path:  # type: ignore[no-untyped-def]
    d = tmp_path / "run"
    (d / "request").mkdir(parents=True)
    (d / "genh.json").write_text(json.dumps({"version": "v0.1.16", "updater": "systemd"}))
    monkeypatch.setenv("GH_HOST_LINK_DIR", str(d))
    get_settings.cache_clear()

    async def fake_latest(repo: str) -> dict[str, str]:
        return {"tag": "v0.1.17", "url": "https://example/v0.1.17", "published_at": "2026-09-28T00:00:00Z",
                "notes": "Nút cập nhật"}

    monkeypatch.setattr(upd, "fetch_latest", fake_latest)
    yield d
    get_settings.cache_clear()


async def test_update_request_lifecycle(owner_api: Api, link: Path, redis) -> None:  # type: ignore[no-untyped-def]
    await redis.delete(upd.LATEST_CACHE_KEY)
    api = owner_api
    r = (await api.get("/system/update")).json()
    assert r["current"] == "v0.1.16" and r["latest"] == "v0.1.17" and r["update_available"]
    assert r["can_request"] and r["state"] == "idle" and r["release_notes"] == "Nút cập nhật"

    r = await api.send("POST", "/system/update")
    assert r.status_code == 202, r.text
    assert r.json()["state"] == "requested"
    req = json.loads((link / "request" / "update.json").read_text())
    assert req["requested_at"] and req["id"]
    # Bấm hai lần không tạo hai lần cập nhật.
    r = await api.send("POST", "/system/update")
    assert r.status_code == 409 and r.json()["code"] == "UPDATE_IN_PROGRESS"

    # genh trên máy chủ nhận yêu cầu (xoá tệp) và báo tiến trình.
    (link / "request" / "update.json").unlink()
    (link / "update-status.json").write_text(json.dumps({"state": "running", "from": "v0.1.16",
                                                         "started_at": "2026-09-28T09:00:00Z"}))
    assert (await api.get("/system/update")).json()["state"] == "running"
    assert (await api.send("POST", "/system/update")).status_code == 409
    (link / "update-status.json").write_text(json.dumps({"state": "done", "from": "v0.1.16", "to": "v0.1.17"}))
    (link / "genh.json").write_text(json.dumps({"version": "v0.1.17", "updater": "systemd"}))
    r = (await api.get("/system/update")).json()
    assert r["state"] == "done" and r["current"] == "v0.1.17" and not r["update_available"]


async def test_stale_request_can_be_retried_and_no_watcher_refuses(owner_api: Api, link: Path, redis) -> None:  # type: ignore[no-untyped-def]
    old = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    (link / "request" / "update.json").write_text(json.dumps({"requested_at": old}))
    assert (await owner_api.get("/system/update")).json()["state"] == "stalled"
    assert (await owner_api.send("POST", "/system/update")).status_code == 202

    (link / "request" / "update.json").unlink()
    (link / "genh.json").write_text(json.dumps({"version": "v0.1.16", "updater": ""}))
    r = await owner_api.send("POST", "/system/update")
    assert r.status_code == 409 and r.json()["code"] == "UPDATER_UNAVAILABLE"
    assert not (link / "request" / "update.json").exists()


async def test_without_host_link_nothing_is_offered(owner_api: Api, tmp_path: Path,
                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GH_HOST_LINK_DIR", str(tmp_path / "missing"))
    get_settings.cache_clear()
    try:
        r = (await owner_api.get("/system/update")).json()
        assert not r["linked"] and not r["can_request"] and not r["update_available"] and r["latest"] is None
        assert (await owner_api.send("POST", "/system/update")).status_code == 409
    finally:
        get_settings.cache_clear()


async def test_only_system_managers_can_update(owner_api: Api, client, db, link: Path) -> None:  # type: ignore[no-untyped-def]
    auditor = await login_as(client, db, "auditor")
    assert (await auditor.get("/system/update")).status_code == 403
    assert (await auditor.send("POST", "/system/update")).status_code == 403
    assert not (link / "request" / "update.json").exists()
