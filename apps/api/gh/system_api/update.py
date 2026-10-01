"""Cập nhật phiên bản ngay trong Console — nút "Cập nhật ngay" thay cho gõ `genh update` trên máy chủ.

Container api không tự nâng cấp được chính nó (dừng/khởi động lại cả hệ thống là việc của genh trên máy chủ), nên
Console chỉ để lại YÊU CẦU trong hộp thư chung `<gốc cài đặt>/run` (bind mount tại `Settings.host_link_dir`, xem
apps/genh/internal/hostlink): một watcher trên máy chủ (systemd path unit / crontab mỗi phút / launchd) thấy tệp
`request/update.json` thì chạy `genh update` — backup → tải bản mới → migrate → khởi động lại, tự rollback nếu lỗi —
và ghi tiến trình vào `update-status.json` cho Console đọc lại. `genh.json` cho biết phiên bản đang chạy và máy chủ
đã có watcher chưa (chưa có ⇒ Console hiện lệnh để Owner tự chạy một lần, lần đó cài luôn watcher).
"""

import json
import logging
import os
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import service
from gh.auth.deps import require
from gh.chassis import actionlog
from gh.config import get_settings
from gh.db import DB
from gh.errors import conflict

log = logging.getLogger(__name__)
router = APIRouter(tags=["system"])
MANAGE = require("system.manage")

LATEST_CACHE_KEY = "gh:update:latest"
# v0.1.30: 1 giờ → 10 phút (Boss thấy "mất nút update" gần 1 giờ sau khi v0.1.29 đã phát hành).
LATEST_CACHE_SECONDS = 600
# `POST /system/update/check` hỏi GitHub ngay (bỏ qua bộ đệm) — tối đa 1 lần / 30 giây cho cả tổ chức.
CHECK_LOCK_KEY = "gh:update:check-lock"
CHECK_MIN_INTERVAL_SECONDS = 30
# Yêu cầu nằm quá lâu mà trạng thái không đổi ⇒ watcher không chạy (máy chủ tắt watcher, linger…) — cho bấm lại.
STALE_REQUEST_SECONDS = 15 * 60
_SEMVER = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")
# v0.1.33: dấu job `promote` (e2e-install.yml) ghi vào ghi chú Release lúc nâng bản thử thành bản chính thức — cùng
# định dạng với apps/genh/internal/selfupdate PromotedMarker. Thời gian chín 24 giờ của lịch đêm tính từ dấu này
# (published_at là lúc tạo bản thử, promote không đổi nó).
_PROMOTED = re.compile(r"<!--\s*genh:promoted_at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s*-->")


def _dir() -> Path:
    return Path(get_settings().host_link_dir)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _parse(v: str | None) -> tuple[int, int, int] | None:
    m = _SEMVER.match((v or "").strip())
    return (int(m[1]), int(m[2]), int(m[3])) if m else None


def is_newer(latest: str | None, current: str | None) -> bool:
    a, b = _parse(latest), _parse(current)
    return a is not None and b is not None and a > b


def _ts(iso: str | None) -> datetime | None:
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else None


def official_since(published_at: str | None, notes: str | None) -> str | None:
    """Lúc bản này thành bản chính thức: dấu promote MUỘN NHẤT trong ghi chú, hoặc published_at — lấy cái muộn hơn,
    như selfupdate.officialSince của genh (cùng mốc lịch đêm dùng để đếm 24 giờ). Không đọc được ⇒ None."""
    times = [t for t in (_ts(published_at), *(_ts(m) for m in _PROMOTED.findall(notes or ""))) if t is not None]
    return max(times).astimezone(UTC).isoformat().replace("+00:00", "Z") if times else None


def strip_markers(notes: str) -> str:
    """Bỏ dấu promote (chú thích HTML, GitHub không hiện) khỏi ghi chú trước khi đưa lên Console."""
    return _PROMOTED.sub("", notes).strip()


async def fetch_latest(repo: str) -> dict[str, Any] | None:
    """Bản phát hành mới nhất trên GitHub (tag, link, ghi chú) — lỗi mạng ⇒ None, không làm hỏng màn hình.

    `published_at` trả về là lúc bản này thành BẢN CHÍNH THỨC (official_since) — Console dùng để báo lịch đêm tự cài
    từ khi nào."""
    try:
        async with httpx.AsyncClient(timeout=6.0, headers={"Accept": "application/vnd.github+json"}) as c:
            r = await c.get(f"https://api.github.com/repos/{repo}/releases/latest")
        if r.status_code != 200:
            return None
        body = r.json()
        raw = body.get("body") or ""
        return {"tag": body.get("tag_name"), "url": body.get("html_url"),
                "published_at": official_since(body.get("published_at"), raw),
                "notes": strip_markers(raw)[:4000]}
    except (httpx.HTTPError, ValueError):
        return None


async def _latest(request: Request, *, force: bool = False) -> dict[str, Any] | None:
    """Bản mới nhất (đệm Redis `LATEST_CACHE_SECONDS`). `force` bỏ qua bộ đệm; hỏi GitHub lỗi thì giữ bản đệm cũ."""
    repo = get_settings().release_repo
    if not repo:
        return None
    redis = request.app.state.redis
    cached_raw = await redis.get(LATEST_CACHE_KEY)
    cached = json.loads(cached_raw) if cached_raw else None
    if cached and not force:
        return cached  # type: ignore[no-any-return]
    latest = await fetch_latest(repo)
    if latest and latest.get("tag"):
        latest = {**latest, "checked_at": datetime.now(UTC).isoformat()}
        await redis.set(LATEST_CACHE_KEY, json.dumps(latest), ex=LATEST_CACHE_SECONDS)
        return latest
    return cached or latest


def _age_seconds(iso: str | None) -> float | None:
    try:
        return (datetime.now(UTC) - datetime.fromisoformat(str(iso).replace("Z", "+00:00"))).total_seconds()
    except ValueError:
        return None


def running_version() -> str | None:
    """Phiên bản genh đã cài (genh.json) — None khi chạy bản phát triển không có hộp thư chung."""
    v = (_read_json(_dir() / "genh.json") or {}).get("version")
    return str(v) if v else None


def _state() -> dict[str, Any]:
    d = _dir()
    info = _read_json(d / "genh.json") or {}
    status = _read_json(d / "update-status.json") or {}
    request = _read_json(d / "request" / "update.json")
    state = status.get("state") or "idle"
    if request is not None:
        age = _age_seconds(request.get("requested_at"))
        state = "stalled" if age is not None and age > STALE_REQUEST_SECONDS else "requested"
    updater = info.get("updater") or None
    # v0.1.33: genh ghi trạng thái lịch tự cập nhật đêm (cài/update/`genh auto-update enable|disable`); genh cũ chưa
    # ghi hoặc giá trị lạ ⇒ None — Console không hứa "Tự cài đêm …".
    auto = info.get("auto_update_enabled")
    # v0.1.34: bản genh đã lỗi + quay về bản cũ — lịch đêm không tự cài lại; Console không hứa "Tự cài đêm …".
    blocked = (_read_json(d / "update-blocked.json") or {}).get("version")
    return {
        "current": info.get("version") or None,
        "updater": updater,
        "auto_update_enabled": auto if isinstance(auto, bool) else None,
        "blocked_version": blocked if isinstance(blocked, str) and blocked else None,
        "linked": d.is_dir(),
        "can_request": bool(updater) and os.access(d / "request", os.W_OK),
        "state": state,
        "message": status.get("message") or None,
        "from": status.get("from") or None,
        "to": status.get("to") or None,
        "started_at": status.get("started_at") or None,
        "finished_at": status.get("finished_at") or None,
        "requested_at": request.get("requested_at") if request else None,
    }


async def _payload(request: Request, *, force: bool = False) -> dict[str, Any]:
    s = _state()
    latest = await _latest(request, force=force) if s["linked"] else None
    tag = latest.get("tag") if latest else None
    return {**s, "latest": tag, "release_url": latest.get("url") if latest else None,
            "release_notes": latest.get("notes") if latest else None,
            "published_at": latest.get("published_at") if latest else None,
            "checked_at": latest.get("checked_at") if latest else None,
            "update_available": is_newer(tag, s["current"])}


@router.get("/system/update")
async def get_update(request: Request, user: service.CurrentUser = Depends(MANAGE)) -> dict[str, Any]:
    """Phiên bản đang chạy, bản mới nhất, và tiến trình cập nhật (idle/requested/running/done/failed/stalled)."""
    return await _payload(request)


@router.post("/system/update/check")
async def check_update(request: Request, user: service.CurrentUser = Depends(MANAGE)) -> dict[str, Any]:
    """v0.1.30: nút "Kiểm tra bản mới" — hỏi GitHub ngay, bỏ qua bộ đệm. Giới hạn 1 lần / 30 giây (bấm dồn thì trả
    kết quả đang đệm, `throttled: true`) để không vượt hạn mức API GitHub không xác thực."""
    fresh = bool(await request.app.state.redis.set(CHECK_LOCK_KEY, "1", nx=True, ex=CHECK_MIN_INTERVAL_SECONDS))
    return {**await _payload(request, force=fresh), "throttled": not fresh}


@router.post("/system/update", status_code=202)
async def request_update(request: Request, db: AsyncSession = DB,
                         user: service.CurrentUser = Depends(MANAGE)) -> dict[str, Any]:
    """Để lại yêu cầu cập nhật cho genh trên máy chủ. Hệ thống sẽ khởi động lại trong vài phút."""
    s = _state()
    if not s["can_request"]:
        raise conflict("UPDATER_UNAVAILABLE",
                       "Máy chủ chưa bật nhận yêu cầu cập nhật từ Console — chạy `genh update` một lần trên máy chủ")
    if s["state"] in ("requested", "running"):
        raise conflict("UPDATE_IN_PROGRESS", "Đang cập nhật — chờ xong rồi thử lại")
    d = _dir()
    restoring = (_read_json(d / "restore-status.json") or {}).get("state") == "running"
    if restoring or (d / "request" / "restore.json").exists():
        raise conflict("RESTORE_IN_PROGRESS", "Đang khôi phục dữ liệu — chờ xong rồi thử lại")
    req = {"id": str(uuid.uuid4()), "requested_at": datetime.now(UTC).isoformat(), "by": user.actor_id}
    target = _dir() / "request" / "update.json"
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(req), encoding="utf-8")
    tmp.replace(target)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="system.update_requested", target_type="system", target_id="update",
                           target_label=s["current"], detail={"request_id": req["id"]}, ip=user.ip)
    await db.commit()
    return await _payload(request)
