"""v0.1.55 (G2) — `GET /system/update` thêm `request_block_reason`: vì sao KHÔNG hiện nút "Cập nhật ngay"
(null ⇔ hiện được nút).

Thứ tự ưu tiên: not_owner → in_progress (requested / running) → genh_unlinked (cùng điều kiện `can_request = false`) →
watcher_stalled (trình nhận yêu cầu lỗi) → up_to_date (không có bản mới). `can_request` giữ nguyên (tương thích).
Mã là chuỗi cố định — không bao giờ mang chữ lấy từ run/ (thư mục 0777, dữ liệu không tin cậy)."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from gh.config import get_settings
from gh.system_api import update as upd
from tests.conftest import Api
from tests.test_system_update import link  # noqa: F401 — fixture dùng chung (hộp thư genh giả + GitHub giả v0.1.17)

VALID = {None, "not_owner", "in_progress", "genh_unlinked", "watcher_stalled", "up_to_date"}


def _ago(**kw: float) -> str:
    return (datetime.now(UTC) - timedelta(**kw)).isoformat().replace("+00:00", "Z")


def _write(folder: Path, name: str, data: Any) -> None:
    (folder / name).write_text(data if isinstance(data, str) else json.dumps(data))


async def _get(api: Api, redis: Any) -> dict[str, Any]:
    await redis.delete(upd.LATEST_CACHE_KEY)
    r = await api.get("/system/update")
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    assert body["request_block_reason"] in VALID
    return body


def test_block_reasons_are_the_five_documented_codes() -> None:
    assert upd.BLOCK_REASONS == ("not_owner", "in_progress", "genh_unlinked", "watcher_stalled", "up_to_date")


# ─── null: nút hiện được ────────────────────────────────────────────────────────────────────────────────────────

async def test_owner_with_updater_and_newer_release_gets_null(owner_api: Api, link: Path, redis: Any) -> None:  # noqa: F811
    body = await _get(owner_api, redis)
    assert body["update_available"] is True and body["can_request"] is True and body["state"] == "idle"
    assert body["request_block_reason"] is None


async def test_failed_or_stalled_retry_state_is_not_blocked(owner_api: Api, link: Path, redis: Any) -> None:  # noqa: F811
    # Lần trước lỗi / yêu cầu nằm quá 15 phút nhưng còn bản mới và trình nhận yêu cầu ổn ⇒ vẫn bấm lại được.
    _write(link, "update-status.json", {"state": "failed", "from": "v0.1.16", "to": "v0.1.17",
                                        "finished_at": _ago(minutes=5), "message": "Cập nhật chưa xong (GH-E941)"})
    body = await _get(owner_api, redis)
    assert body["state"] == "failed" and body["request_block_reason"] is None
    (link / "update-status.json").unlink()
    _write(link / "request", "update.json", {"requested_at": _ago(hours=1)})
    body = await _get(owner_api, redis)
    assert body["state"] == "stalled" and body["stalled_reason"] == "not_picked_up"
    assert body["request_block_reason"] is None


# ─── up_to_date ─────────────────────────────────────────────────────────────────────────────────────────────────

async def test_up_to_date_when_running_the_latest_version(owner_api: Api, link: Path, redis: Any) -> None:  # noqa: F811
    _write(link, "genh.json", {"version": "v0.1.17", "updater": "systemd"})
    body = await _get(owner_api, redis)
    assert body["update_available"] is False and body["can_request"] is True
    assert body["request_block_reason"] == "up_to_date"


# ─── in_progress ────────────────────────────────────────────────────────────────────────────────────────────────

async def test_in_progress_when_requested_or_running(owner_api: Api, link: Path, redis: Any) -> None:  # noqa: F811
    _write(link / "request", "update.json", {"requested_at": _ago(minutes=1)})
    body = await _get(owner_api, redis)
    assert body["state"] == "requested" and body["request_block_reason"] == "in_progress"
    (link / "request" / "update.json").unlink()
    _write(link, "update-status.json", {"state": "running", "from": "v0.1.16", "started_at": _ago(minutes=2)})
    _write(link, "genh-heartbeat.json", {"op": "update", "boot_id": "", "started_at": _ago(minutes=2),
                                         "at": _ago(seconds=10)})
    body = await _get(owner_api, redis)
    assert body["state"] == "running" and body["request_block_reason"] == "in_progress"


async def test_post_update_and_check_carry_the_reason_too(owner_api: Api, link: Path, redis: Any) -> None:  # noqa: F811
    await redis.delete(upd.LATEST_CACHE_KEY)
    r = await owner_api.send("POST", "/system/update/check")
    assert r.status_code == 200 and r.json()["request_block_reason"] is None
    r = await owner_api.send("POST", "/system/update")
    assert r.status_code == 202 and r.json()["state"] == "requested"
    assert r.json()["request_block_reason"] == "in_progress"            # vừa gửi yêu cầu ⇒ đang chờ máy chủ làm


# ─── genh_unlinked ──────────────────────────────────────────────────────────────────────────────────────────────

async def test_genh_unlinked_without_updater_or_without_host_link(owner_api: Api, link: Path, redis: Any,  # noqa: F811
                                                                  tmp_path: Path,
                                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    _write(link, "genh.json", {"version": "v0.1.16", "updater": ""})
    body = await _get(owner_api, redis)
    assert body["can_request"] is False and body["update_available"] is True
    assert body["request_block_reason"] == "genh_unlinked"
    # Hộp thư `request/` không ghi được (updater có mà thư mục đóng) cũng là chưa bật cập nhật bằng nút bấm.
    _write(link, "genh.json", {"version": "v0.1.16", "updater": "systemd"})
    (link / "request").chmod(0o500)
    try:
        body = await _get(owner_api, redis)
        if not body["can_request"]:                      # root bỏ qua quyền thư mục: chỉ kiểm khi chmod có tác dụng
            assert body["request_block_reason"] == "genh_unlinked"
    finally:
        (link / "request").chmod(0o700)
    # Không có hộp thư chung (bản không cài bằng genh): không cập nhật bằng nút.
    monkeypatch.setenv("GH_HOST_LINK_DIR", str(tmp_path / "missing"))
    get_settings.cache_clear()
    try:
        body = await _get(owner_api, redis)
        assert body["linked"] is False and body["request_block_reason"] == "genh_unlinked"
    finally:
        get_settings.cache_clear()


# ─── watcher_stalled ────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw", [
    {"request_watcher": "failed"},
    {"watcher": {"state": "failed", "reason": "inotify"}},
    {"watcher": {"state": "failed", "reason": "resources"}, "request_watcher": "active"},
])
async def test_watcher_stalled_when_the_request_receiver_is_broken(owner_api: Api, link: Path, redis: Any,  # noqa: F811
                                                                   raw: dict[str, Any]) -> None:
    _write(link, "nightly-status.json", {"schema": 1, "mechanism": "systemd", "enabled": True, **raw})
    body = await _get(owner_api, redis)
    assert body["can_request"] is True and body["update_available"] is True
    assert body["request_block_reason"] == "watcher_stalled"


async def test_watcher_stalled_also_when_an_old_request_was_blamed_on_the_watcher(
        owner_api: Api, link: Path, redis: Any) -> None:  # noqa: F811
    _write(link / "request", "update.json", {"requested_at": _ago(hours=1)})
    _write(link, "nightly-status.json", {"request_watcher": "failed"})
    body = await _get(owner_api, redis)
    assert body["state"] == "stalled" and body["stalled_reason"] == "watcher_failed"
    assert body["request_block_reason"] == "watcher_stalled"


@pytest.mark.parametrize("raw", [
    {"watcher": {"state": "ok"}, "request_watcher": "active"},
    {"watcher": {"state": "fallback", "reason": "inotify"}, "request_watcher": "active"},   # timer dự phòng vẫn nhận
    {"request_watcher": "inactive"},
    {"request_watcher": "ĐỘC-HẠI"}, {"watcher": "x"}, {"watcher": {"state": 7}},           # giá trị lạ ⇒ không chặn
])
async def test_working_or_unknown_watcher_does_not_block_the_button(owner_api: Api, link: Path, redis: Any,  # noqa: F811
                                                                    raw: Any) -> None:
    _write(link, "nightly-status.json", {"schema": 1, **raw})
    body = await _get(owner_api, redis)
    assert body["request_block_reason"] is None


# ─── thứ tự ưu tiên ─────────────────────────────────────────────────────────────────────────────────────────────

async def test_priority_order_between_reasons(owner_api: Api, link: Path, redis: Any) -> None:  # noqa: F811
    _write(link, "nightly-status.json", {"request_watcher": "failed"})
    _write(link, "genh.json", {"version": "v0.1.17", "updater": "systemd"})              # đã mới nhất + người gác lỗi
    assert (await _get(owner_api, redis))["request_block_reason"] == "watcher_stalled"      # > up_to_date
    _write(link, "genh.json", {"version": "v0.1.17", "updater": ""})                      # chưa bật + người gác lỗi
    assert (await _get(owner_api, redis))["request_block_reason"] == "genh_unlinked"        # > watcher_stalled
    _write(link / "request", "update.json", {"requested_at": _ago(minutes=1)})            # đang chờ làm yêu cầu
    assert (await _get(owner_api, redis))["request_block_reason"] == "in_progress"          # > genh_unlinked


def test_not_owner_comes_first_and_is_a_pure_decision() -> None:
    """Chỉ Owner bấm cập nhật được: mọi vai trò khác (kể cả vai trò tuỳ biến có `system.manage`) ⇒ not_owner, trước cả
    in_progress. Hàm thuần — không đọc đĩa."""
    state = {"state": "requested", "can_request": False, "stalled_reason": "watcher_failed"}
    nightly = {"request_watcher": "failed", "watcher": {"state": "failed", "reason": "other"}}
    manager = SimpleNamespace(role_code="manager")
    owner = SimpleNamespace(role_code="owner")
    assert upd.request_block_reason(manager, state, nightly, update_available=True) == "not_owner"  # type: ignore[arg-type]
    assert upd.request_block_reason(manager, state, nightly, update_available=False) == "not_owner"  # type: ignore[arg-type]
    assert upd.request_block_reason(owner, state, nightly, update_available=True) == "in_progress"  # type: ignore[arg-type]
    idle = {**state, "state": "idle"}
    assert upd.request_block_reason(owner, idle, nightly, update_available=True) == "genh_unlinked"  # type: ignore[arg-type]
    ok = {"state": "idle", "can_request": True, "stalled_reason": None}
    assert upd.request_block_reason(owner, ok, None, update_available=True) is None  # type: ignore[arg-type]
    assert upd.request_block_reason(owner, ok, None, update_available=False) == "up_to_date"  # type: ignore[arg-type]


async def test_non_owner_roles_cannot_even_read_the_update_card(owner_api: Api, link: Path, client: Any,  # noqa: F811
                                                                db: Any) -> None:
    from tests.test_rbac_api import login_as

    other = await login_as(client, db, "manager")
    try:
        assert (await other.get("/system/update")).status_code == 403       # Console im lặng; không lộ lý do
    finally:
        await other.c.aclose()
