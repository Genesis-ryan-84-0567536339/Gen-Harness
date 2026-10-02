"""Sức khoẻ hệ thống + chuông tự khử trùng lặp (v0.1.36 — F-6, F-3, F-4).

Mỗi "sự cố đang mở" là MỘT dòng `ops.health_alerts` theo (org_id, key) — migration 0024. Đây là nguồn sự thật cho
cả chuông (core.notifications) lẫn dải "Cần Sếp xử lý" ở Tổng quan:

- `raise_once` chỉ gửi chuông khi dòng MỚI mở (chưa có / đã đóng) hoặc `fingerprint` đổi (vd. một lần cập nhật lỗi
  KHÁC) — sự kiện lặp lại (bridge gửi `session.ended` nhiều lần, model 401 liên tục…) KHÔNG sinh chuông thứ hai.
- `clear` đóng dòng khi hết sự cố; lần sau sự cố quay lại mới có chuông mới.
- `collect` dựng khuôn `GET /api/v1/system/health` (đọc thuần, không gửi chuông). KHÔNG đụng `/ready`: genh dùng
  `/ready` để quyết rollback (apps/genh/internal/ops/update.go) — bộ xử lý nền im không được làm hỏng một bản cập
  nhật tốt.
- `evaluate` + `watch_loop` (chạy trong api, `Settings.health_watch_seconds`): mỗi phút tính lại các sự cố theo dõi
  định kỳ (cập nhật lỗi trong 24 giờ, quá hạn sao lưu theo tần suất bước 11, bộ xử lý nền im, ổ đĩa sắp đầy, model
  đang hết đăng nhập) và dọn dòng sự kiện cũ.

Hợp đồng Redis với worker (gh/worker.py ghi): `gh:cron:last:<tên hàm>` = JSON {"at": ISO UTC 'Z', "ok": bool,
"ms": int}; `gh:worker:heartbeat` = ISO UTC. Mọi chuỗi hiện cho người dùng là tiếng Việt thân thiện, không đường dẫn
tệp, không bí mật.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import orjson
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger("gh.health")

#: Quá hạn sao lưu theo `settings->'backup'->>'frequency'` (bước 11 / PUT /backups/schedule): một chu kỳ + 12 giờ
#: dư (hằng ngày giữ mốc 36 giờ cũ). Giá trị lạ ⇒ như hằng ngày (khớp `gh.backup.is_due`).
BACKUP_STALE_HOURS = 36
BACKUP_STALE_LIMITS: dict[str, tuple[timedelta, str]] = {
    "daily": (timedelta(hours=BACKUP_STALE_HOURS), f"{BACKUP_STALE_HOURS} giờ"),
    "weekly": (timedelta(days=7, hours=12), "một tuần"),
    "monthly": (timedelta(days=31, hours=12), "một tháng"),
}
#: Cập nhật lỗi chỉ còn là sự cố trong 24 giờ sau khi xong — khớp thẻ cập nhật ở web (updateModel.ts RECENT_MS):
#: quá hạn thì thẻ không còn lỗi để xem/thử lại, dải "Cần Sếp xử lý" cũng thôi báo.
UPDATE_FAILED_RECENT = timedelta(hours=24)
WORKER_SILENT_MINUTES = 10
HEARTBEAT_KEY = "gh:worker:heartbeat"
CRON_LAST_PREFIX = "gh:cron:last:"
WATCH_LOCK_KEY = "gh:health:tick"
#: browser-worker ghi nhịp mỗi 15 giây (TTL 45 giây — apps/browser/ghb/worker.py) — quá 40 giây coi như im. Ngưỡng
#: phải DƯỚI TTL: quá TTL khoá biến mất và trạng thái thành 'off' (không phân biệt được với chưa bật).
BROWSER_SILENT_SECONDS = 40

STORAGE_LINK = "/system?tab=storage"

#: Nhãn nút hành động theo kind (web hiện trên dải "Cần Sếp xử lý").
ACTIONS = {
    "channel.down": "Đăng nhập lại",
    "model.auth_expired": "Đăng nhập lại model",
    "update.failed": "Xem & thử lại",
    "backup.stale": "Sao lưu ngay",
    "worker.silent": "Xem sức khoẻ",
    "disk.low": "Xem cách giải phóng",
}


def _iso(dt: datetime | None) -> str | None:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z") if dt else None


def _parse_ts(value: Any) -> datetime | None:
    if isinstance(value, bytes):
        value = value.decode(errors="replace")
    if not isinstance(value, str) or not value:
        return None
    try:
        t = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=UTC)


def _s(value: Any) -> str:
    return value.decode(errors="replace") if isinstance(value, bytes) else str(value)


# ─── dòng sự cố: mở một lần / đóng ───────────────────────────────────────────────────────────────────────────

async def raise_once(db: AsyncSession, org_id: uuid.UUID, *, key: str, kind: str, severity: str, title: str,
                     body: str, link: str | None, fingerprint: str = "", redis: Any = None) -> bool:
    """Mở sự cố `key`; gửi chuông cho các Owner CHỈ khi dòng mới mở hoặc `fingerprint` đổi. Trả True nếu đã gửi.

    Sự cố đang mở với cùng fingerprint ⇒ không chuông thứ hai (chỉ làm mới tiêu đề/nội dung cho dải "Cần Sếp xử lý",
    vd. số phút bộ xử lý nền đã ngừng). Bên gọi commit (chuông đẩy WebSocket sau commit — gh.notifications)."""
    from gh import notifications

    params = {"o": org_id, "k": key, "kind": kind, "sev": severity, "t": title, "b": body, "l": link,
              "f": fingerprint}
    fresh = (await db.execute(text("""
        INSERT INTO ops.health_alerts (org_id, key, kind, severity, fingerprint, title, body, link)
        VALUES (:o, :k, :kind, :sev, :f, :t, :b, :l)
        ON CONFLICT (org_id, key) DO UPDATE SET kind = EXCLUDED.kind, severity = EXCLUDED.severity,
               title = EXCLUDED.title, body = EXCLUDED.body, link = EXCLUDED.link,
               fingerprint = EXCLUDED.fingerprint, raised_at = now(), cleared_at = NULL
        WHERE ops.health_alerts.cleared_at IS NOT NULL
           OR ops.health_alerts.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
        RETURNING key"""), params)).scalar_one_or_none()
    if fresh is None:
        await db.execute(text("""
            UPDATE ops.health_alerts SET title = :t, body = :b, link = :l
            WHERE org_id = :o AND key = :k AND cleared_at IS NULL
              AND (title, body, link) IS DISTINCT FROM (:t, :b, :l)"""),
            {"o": org_id, "k": key, "t": title, "b": body, "l": link})
        return False
    await notifications.notify(db, org_id, await notifications.owner_ids(db, org_id), kind=kind, title=title,
                               body=body, link=link, redis=redis)
    return True


async def clear(db: AsyncSession, org_id: uuid.UUID, key: str) -> bool:
    """Đóng sự cố `key` đang mở (hết sự cố). Trả True nếu có dòng được đóng. Bên gọi commit."""
    res = await db.execute(text("""UPDATE ops.health_alerts SET cleared_at = now()
                                   WHERE org_id = :o AND key = :k AND cleared_at IS NULL"""),
                           {"o": org_id, "k": key})
    return bool(getattr(res, "rowcount", 0))


async def active_issues(db: AsyncSession, org_id: uuid.UUID) -> list[dict[str, Any]]:
    """Sự cố đang mở: 'bad' trước, rồi mới nhất trước. Mọi trường là chuỗi (web không render object)."""
    rows = (await db.execute(text("""
        SELECT key, kind, severity, title, body, link, raised_at FROM ops.health_alerts
        WHERE org_id = :o AND cleared_at IS NULL
        ORDER BY (severity = 'bad') DESC, raised_at DESC"""), {"o": org_id})).all()
    return [{"key": r.key, "kind": r.kind, "severity": r.severity, "title": r.title, "body": r.body,
             "link": r.link, "action": ACTIONS.get(r.kind, "Xem chi tiết"), "raised_at": _iso(r.raised_at)}
            for r in rows]


# ─── đọc nguồn (mọi lỗi ⇒ None/'unknown', không ném) ─────────────────────────────────────────────────────────

async def _cron_runs(redis: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    async for k in redis.scan_iter(match=f"{CRON_LAST_PREFIX}*", count=200):
        name = _s(k)[len(CRON_LAST_PREFIX):]
        raw = await redis.get(k)
        data: dict[str, Any] = {}
        with contextlib.suppress(ValueError, TypeError):
            loaded = orjson.loads(raw) if raw else {}
            data = loaded if isinstance(loaded, dict) else {}
        at = _parse_ts(data.get("at"))
        ok = data.get("ok")
        out.append({"name": name, "last_at": _iso(at), "ok": ok if isinstance(ok, bool) else None, "_at": at})
    out.sort(key=lambda c: c["name"])
    return out


async def _worker_last_seen(redis: Any, crons: list[dict[str, Any]] | None = None) -> datetime | None:
    seen = [_parse_ts(await redis.get(HEARTBEAT_KEY))]
    seen += [c["_at"] for c in (crons if crons is not None else await _cron_runs(redis))]
    times = [t for t in seen if t is not None]
    return max(times) if times else None


def _worker_state(last_seen: datetime | None, *, now: datetime, started_at: datetime | None) -> tuple[str, int | None]:
    """('ok'|'silent'|'unknown', số phút im). Chưa từng thấy: im khi api đã chạy quá 10 phút (đủ thời gian để
    worker khởi động và ghi nhịp đầu tiên), còn không ⇒ 'unknown'."""
    limit = timedelta(minutes=WORKER_SILENT_MINUTES)
    if last_seen is not None:
        gap = now - last_seen
        return ("silent", int(gap.total_seconds() // 60)) if gap > limit else ("ok", None)
    if started_at is not None and now - started_at > limit:
        return "silent", int((now - started_at).total_seconds() // 60)
    return "unknown", None


def _host_dir() -> Any:
    from gh.system_api import update

    return update._dir()


def _disk_status() -> dict[str, Any] | None:
    from gh.system_api import update

    d = _host_dir()
    if not d.is_dir():
        return None
    return update._read_json(d / "disk-status.json")


def _gb(n: Any) -> str:
    try:
        v = float(n) / (1 << 30)
    except (TypeError, ValueError):
        return "?"
    out = f"{v:.1f}".replace(".", ",")
    return out[:-2] if out.endswith(",0") else out


async def _org_backup_cfg(db: AsyncSession, org_id: uuid.UUID) -> Any:
    return (await db.execute(text("""SELECT settings ? 'backup' AS configured, created_at, timezone,
                                            settings->'backup'->>'frequency' AS frequency
                                     FROM core.organizations WHERE id = :o"""), {"o": org_id})).one_or_none()


async def _latest_backup() -> datetime | None:
    from gh import backup

    entries = await backup.list_backups()  # mới nhất trước — TÍNH CẢ bản pre-update/pre-restore
    return entries[0].taken_at if entries else None


def backup_stale_limit(frequency: str | None) -> tuple[timedelta, str]:
    """(hạn, chữ hiện cho Sếp) theo tần suất sao lưu đã cấu hình — giá trị lạ/thiếu ⇒ hằng ngày."""
    return BACKUP_STALE_LIMITS.get(frequency or "daily", BACKUP_STALE_LIMITS["daily"])


def _backup_stale(configured: bool, latest: datetime | None, org_created: datetime | None, now: datetime,
                  frequency: str | None = None) -> bool:
    limit, _ = backup_stale_limit(frequency)
    if not configured:
        return False
    if latest is not None:
        return now - latest > limit
    return org_created is not None and now - org_created > limit


# ─── GET /system/health ───────────────────────────────────────────────────────────────────────────────────────

async def collect(db: AsyncSession, redis: Any, org_id: uuid.UUID, *, now: datetime | None = None,
                  started_at: datetime | None = None) -> dict[str, Any]:
    """Khuôn trả về của `GET /api/v1/system/health` — mọi trường là chuỗi/số/bool/null. Đọc một nguồn lỗi ⇒ phần
    đó 'unknown', KHÔNG ném 500."""
    now = now or datetime.now(UTC)

    worker: dict[str, Any] = {"state": "unknown", "alive": False, "last_seen_at": None, "silent_minutes": None}
    crons: list[dict[str, Any]] = []
    try:
        from arq.constants import default_queue_name, health_check_key_suffix

        crons = await _cron_runs(redis)
        last_seen = await _worker_last_seen(redis, crons)
        state, minutes = _worker_state(last_seen, now=now, started_at=started_at)
        alive = bool(await redis.exists(f"{default_queue_name}{health_check_key_suffix}"))
        worker = {"state": state, "alive": alive, "last_seen_at": _iso(last_seen), "silent_minutes": minutes}
    except Exception:  # noqa: BLE001 — Redis lỗi: phần này 'unknown'
        log.warning("Không đọc được trạng thái bộ xử lý nền", exc_info=True)

    browser: dict[str, Any] = {"state": "off", "last_heartbeat_at": None}
    try:
        from gh.social import service as social_service

        ws = await social_service.worker_state(redis)
        at = _parse_ts((ws or {}).get("at"))
        if ws is not None:
            fresh = at is not None and (now - at).total_seconds() <= BROWSER_SILENT_SECONDS
            browser = {"state": "ok" if fresh else "silent", "last_heartbeat_at": _iso(at)}
    except Exception:  # noqa: BLE001
        log.warning("Không đọc được nhịp trình duyệt nền", exc_info=True)

    queues: list[dict[str, Any]] = []
    try:
        async for k in redis.scan_iter(match="*.dlq", count=200, _type="stream"):
            name = _s(k)
            queues.append({"stream": name[: -len(".dlq")], "dlq": int(await redis.xlen(k))})
        queues.sort(key=lambda q: q["stream"])
    except Exception:  # noqa: BLE001
        log.warning("Không đọc được hàng đợi lỗi (DLQ)", exc_info=True)

    backup: dict[str, Any] = {"configured": False, "latest_at": None, "age_hours": None, "stale": False,
                              "frequency": None, "stale_after": None}
    try:
        cfg = await _org_backup_cfg(db, org_id)
        configured = bool(cfg and cfg.configured)
        frequency = cfg.frequency if cfg and cfg.frequency in BACKUP_STALE_LIMITS else ("daily" if configured else None)
        latest = await _latest_backup()
        backup = {"configured": configured, "latest_at": _iso(latest),
                  "age_hours": round((now - latest).total_seconds() / 3600, 1) if latest else None,
                  "stale": _backup_stale(configured, latest, cfg.created_at if cfg else None, now, frequency),
                  "frequency": frequency, "stale_after": backup_stale_limit(frequency)[1] if configured else None}
    except Exception:  # noqa: BLE001
        log.warning("Không đọc được danh mục sao lưu", exc_info=True)

    update: dict[str, Any] = {"state": "unknown", "failed": False, "blocked_version": None, "finished_at": None}
    disk: dict[str, Any] = {"state": "unknown", "free_bytes": None, "min_bytes": None, "checked_at": None}
    try:
        from gh.system_api import update as upd

        if _host_dir().is_dir():
            st = upd._state()
            update = {"state": str(st.get("state") or "unknown"), "failed": _update_failed_recent(st, now),
                      "blocked_version": st.get("blocked_version"), "finished_at": st.get("finished_at")}
            ds = _disk_status() or {}
            disk_state = str(ds.get("state")) if ds.get("state") in ("ok", "low") else "unknown"
            disk = {"state": disk_state,
                    "free_bytes": ds.get("free_bytes") if isinstance(ds.get("free_bytes"), int) else None,
                    "min_bytes": ds.get("min_bytes") if isinstance(ds.get("min_bytes"), int) else None,
                    "checked_at": ds.get("checked_at") if isinstance(ds.get("checked_at"), str) else None}
    except Exception:  # noqa: BLE001
        log.warning("Không đọc được hộp thư với genh", exc_info=True)

    issues: list[dict[str, Any]] = []
    try:
        issues = await active_issues(db, org_id)
    except Exception:  # noqa: BLE001
        log.warning("Không đọc được sự cố đang mở", exc_info=True)

    bad = (any(i["severity"] == "bad" for i in issues) or worker["state"] == "silent" or update["failed"]
           or disk["state"] == "low" or backup["stale"])
    warn = (any(i["severity"] == "warn" for i in issues) or browser["state"] == "silent"
            or any(q["dlq"] > 0 for q in queues) or any(c["ok"] is False for c in crons))
    return {
        "checked_at": _iso(now),
        "overall": "bad" if bad else ("warn" if warn else "ok"),
        "worker": worker,
        "browser": browser,
        "queues": queues,
        "crons": [{"name": c["name"], "last_at": c["last_at"], "ok": c["ok"]} for c in crons],
        "backup": backup,
        "update": update,
        "disk": disk,
        "issues": issues,
    }


# ─── vòng theo dõi: mở/đóng sự cố định kỳ ────────────────────────────────────────────────────────────────────

def _update_failed_recent(st: dict[str, Any], now: datetime) -> bool:
    """Lần cập nhật lỗi còn là sự cố: state 'failed' VÀ `finished_at` trong 24 giờ — cùng điều kiện với thẻ cập nhật
    ở web (updateModel.ts `recent`): thiếu/hỏng `finished_at` ⇒ không tính."""
    if st.get("state") != "failed":
        return False
    finished = _parse_ts(st.get("finished_at"))
    return finished is not None and now - finished < UPDATE_FAILED_RECENT


async def _eval_update(db: AsyncSession, org_id: uuid.UUID, redis: Any, now: datetime) -> None:
    from gh.system_api import update as upd

    if not _host_dir().is_dir():
        return
    st = upd._state()
    state = st.get("state")
    if _update_failed_recent(st, now):
        target = st.get("to") or "bản mới"
        if st.get("blocked_rollback_failed") is True:
            body = "Tự quay về bản cũ cũng lỗi — cần hỗ trợ ngay."
        elif st.get("blocked_version"):
            body = "Hệ thống đã tự quay về bản cũ, dữ liệu an toàn. Bấm để xem và thử lại."
        else:
            body = "Bấm để xem chi tiết và thử lại."
        await raise_once(db, org_id, key="update.failed", kind="update.failed", severity="bad",
                         title=f"Cập nhật lên {target} chưa thành công", body=body, link=STORAGE_LINK,
                         fingerprint=f"{st.get('finished_at') or ''}|{st.get('to') or ''}", redis=redis)
    elif state in ("done", "idle", "failed"):  # 'failed' quá 24 giờ: thẻ cập nhật đã thôi báo ⇒ đóng sự cố
        await clear(db, org_id, "update.failed")


async def _eval_backup(db: AsyncSession, org_id: uuid.UUID, redis: Any, now: datetime) -> None:
    from zoneinfo import ZoneInfo

    cfg = await _org_backup_cfg(db, org_id)
    if cfg is None or not cfg.configured:
        await clear(db, org_id, "backup.stale")
        return
    latest = await _latest_backup()
    limit_text = backup_stale_limit(cfg.frequency)[1]
    if not _backup_stale(True, latest, cfg.created_at, now, cfg.frequency):
        await clear(db, org_id, "backup.stale")
        return
    if latest is not None:
        try:
            tz: Any = ZoneInfo(cfg.timezone or "UTC")
        except (ValueError, KeyError):
            tz = UTC
        last = f"Bản gần nhất lúc {latest.astimezone(tz):%d/%m %H:%M}."
    else:
        last = "Chưa có bản nào."
    await raise_once(db, org_id, key="backup.stale", kind="backup.stale", severity="bad",
                     title=f"Đã hơn {limit_text} chưa có bản sao lưu mới",
                     body=f"{last} Bấm Sao lưu ngay để giữ an toàn dữ liệu.", link=STORAGE_LINK, redis=redis)


async def _eval_worker(db: AsyncSession, org_id: uuid.UUID, redis: Any, now: datetime,
                       started_at: datetime | None) -> None:
    state, minutes = _worker_state(await _worker_last_seen(redis), now=now, started_at=started_at)
    if state == "silent":
        await raise_once(db, org_id, key="worker.silent", kind="worker.silent", severity="bad",
                         title=f"Bộ xử lý nền đã ngừng {minutes} phút",
                         body="Sàng lọc tin, nhắc việc và sao lưu theo lịch đang dừng. "
                              "Bấm để xem cách khởi động lại.", link=STORAGE_LINK, redis=redis)
    elif state == "ok":
        await clear(db, org_id, "worker.silent")


async def _eval_disk(db: AsyncSession, org_id: uuid.UUID, redis: Any) -> None:
    ds = _disk_status()
    if ds is None:
        return
    if ds.get("state") == "low":
        await raise_once(db, org_id, key="disk.low", kind="disk.low", severity="bad", title="Ổ đĩa sắp hết chỗ",
                         body=f"Còn {_gb(ds.get('free_bytes'))} GB trống, cần tối thiểu {_gb(ds.get('min_bytes'))} GB"
                              " — cập nhật tự động đang tạm dừng.", link=STORAGE_LINK, redis=redis)
    elif ds.get("state") == "ok":
        await clear(db, org_id, "disk.low")


async def raise_model_expired(db: AsyncSession, org_id: uuid.UUID, provider_id: uuid.UUID, name: str, *,
                              redis: Any = None) -> bool:
    """Sự cố "model cần đăng nhập lại" — một khoá mỗi nhà cung cấp (`model.auth_expired:<uuid>`)."""
    return await raise_once(
        db, org_id, key=f"model.auth_expired:{provider_id}", kind="model.auth_expired", severity="warn",
        title=f"Model {name} cần đăng nhập lại",
        body="Gen và sàng lọc tin có thể dừng nếu không còn model khác. Bấm để đăng nhập lại.",
        link="/system?tab=brain", redis=redis)


async def _eval_models(db: AsyncSession, org_id: uuid.UUID, redis: Any) -> None:
    """Model đang bật mà 'expired' nhưng chưa có sự cố — vd. đã hết hạn TRƯỚC khi lên v0.1.36, hoặc nút "Gọi thử"
    đổi sang 'expired' (lần 401 sau đó không đổi trạng thái nên `_set_auth_state` không mở). Khoá khử trùng lặp ⇒
    sự cố đang mở thì không chuông thêm."""
    rows = (await db.execute(text("""SELECT id, name FROM agent.providers
                                     WHERE org_id = :o AND is_enabled AND auth_state = 'expired'"""),
                             {"o": org_id})).all()
    for r in rows:
        await raise_model_expired(db, org_id, r.id, r.name, redis=redis)


async def _eval_events(db: AsyncSession, org_id: uuid.UUID) -> None:
    """Dọn dòng sự kiện cũ: kênh đã đăng nhập lại / model đã ổn (hoặc bị tắt, bị xoá) ⇒ đóng sự cố."""
    keys = (await db.execute(text("""SELECT key FROM ops.health_alerts WHERE org_id = :o AND cleared_at IS NULL
                                      AND (key LIKE 'channel.down:%' OR key LIKE 'model.auth_expired:%')"""),
                             {"o": org_id})).scalars().all()
    for key in keys:
        kind, _, ref = key.partition(":")
        if kind == "channel.down":
            live = (await db.execute(text("""
                SELECT 1 FROM core.channel_sessions s JOIN core.channels c ON c.id = s.channel_id
                WHERE c.org_id = :o AND c.type = :t AND s.state = 'active' AND s.ended_at IS NULL LIMIT 1"""),
                {"o": org_id, "t": ref})).first()
            if live is not None:
                await clear(db, org_id, key)
        else:
            try:
                pid = uuid.UUID(ref)
            except ValueError:
                await clear(db, org_id, key)
                continue
            p = (await db.execute(text("SELECT is_enabled, auth_state FROM agent.providers WHERE id = :i"),
                                  {"i": pid})).one_or_none()
            if p is None or not p.is_enabled or p.auth_state != "expired":
                await clear(db, org_id, key)


async def evaluate(db: AsyncSession, redis: Any, org_id: uuid.UUID, *, now: datetime,
                   started_at: datetime | None) -> None:
    """Tính lại các sự cố theo dõi định kỳ và mở/đóng dòng tương ứng (chuông chỉ khi mới mở). Bên gọi commit.

    Mỗi phần chạy trong savepoint riêng: một nguồn lỗi (tệp hỏng, Redis tạm mất) không chặn các phần còn lại."""
    parts = (
        ("update.failed", lambda: _eval_update(db, org_id, redis, now)),
        ("backup.stale", lambda: _eval_backup(db, org_id, redis, now)),
        ("worker.silent", lambda: _eval_worker(db, org_id, redis, now, started_at)),
        ("disk.low", lambda: _eval_disk(db, org_id, redis)),
        ("models", lambda: _eval_models(db, org_id, redis)),
        ("events", lambda: _eval_events(db, org_id)),
    )
    from gh import notifications

    for name, run in parts:
        mark = notifications.pending_mark(db)
        try:
            async with db.begin_nested():
                await run()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — một phần lỗi không làm hỏng cả lượt
            notifications.pending_reset(db, mark)
            log.exception("Theo dõi sức khoẻ: phần %s lỗi", name)


async def watch_loop(sm: Any, redis: Any, stop: asyncio.Event, *, interval: float, started_at: datetime) -> None:
    """Vòng theo dõi chạy trong api: chờ `interval` giây đầu rồi mỗi `interval` giây gọi `evaluate` cho từng tổ chức.
    Nhiều tiến trình api ⇒ khoá Redis `WATCH_LOCK_KEY` để chỉ một bản chạy mỗi lượt. Không chết vì một lượt lỗi
    (khuôn `gh.app._permit_sweep_loop`)."""
    while not stop.is_set():
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval)
        if stop.is_set():
            return
        try:
            if not await redis.set(WATCH_LOCK_KEY, b"1", nx=True, ex=max(1, int(interval - 5))):
                continue
            async with sm() as db:
                orgs = (await db.execute(text("SELECT id FROM core.organizations ORDER BY created_at"))
                        ).scalars().all()
            for org_id in orgs:
                async with sm() as db:
                    await evaluate(db, redis, org_id, now=datetime.now(UTC), started_at=started_at)
                    await db.commit()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — vòng theo dõi không được chết vì một lượt lỗi
            log.exception("Vòng theo dõi sức khoẻ lỗi")
