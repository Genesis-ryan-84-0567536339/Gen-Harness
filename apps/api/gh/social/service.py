"""Tài khoản mạng xã hội + việc trình duyệt (v0.1.29, docs/design/gen-browser-agent.md §3, §5.1) — CHỈ ĐỌC.

Luồng: api ghi `agent.browser_jobs` → ký việc (khoá browser, KHÔNG phải khoá master) → XADD `gh:browser:jobs` →
browser-worker (container riêng, không DB, không khoá master) chạy Playwright → XADD `gh:browser:results` (đã ký) →
consumer trong api (`consume_results`) cập nhật DB, lưu phiên (mã hoá phong bì bằng khoá master), báo chuông Owner.

Giới hạn (trần cứng trong code — Owner chỉ chỉnh XUỐNG): đọc ≤ 6 lượt/ngày/tài khoản, cách nhau ≥ 10 phút; mỗi tài
khoản tối đa 1 việc cùng lúc (ở đây + khoá Redis ở worker); lịch tự động không chạy 23:00–06:00. Công tắc "Dừng tất
cả" (`gh:browser:halt`) chặn việc mới và báo worker đóng mọi trình duyệt ngay.
"""

import asyncio
import contextlib
import logging
import re
import secrets
import uuid
import weakref
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import orjson
from cryptography.exceptions import InvalidTag
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh import crypto, notifications, realtime
from gh.auth import service as auth_service
from gh.chassis import actionlog
from gh.config import get_settings
from gh.errors import ApiError, conflict, field_errors, not_found
from gh.social import platforms, protocol

log = logging.getLogger("gh.social")

READS_PER_DAY_MAX = 6
READ_MIN_INTERVAL = timedelta(minutes=10)
LOGINS_PER_DAY_MAX = 6
HEALTH_PER_DAY_MAX = 8
FAIL_STREAK_PAUSE = 3
LOGIN_TIMEOUT_S = 600
JOB_TTL_S = 900                  # việc chưa được nhận sau 15 phút → hết hạn (worker bỏ qua)
STALE_AFTER = timedelta(minutes=15)
QUIET_HOURS = (23, 6)            # lịch tự động không chạy 23:00–06:00
RECENT_READ_REUSE = timedelta(minutes=10)
MAX_PAGES_PER_JOB = 40
MAX_ITEMS = 30
ITEM_TEXT_MAX = 500
TICKET_PREFIX = "gh:social:ticket:"

EVENT = "social.update"
realtime.register_event(EVENT, "system.manage")

# Chữ trên trang thường gặp trong lừa đảo/tấn công prompt — vẫn chỉ là dữ liệu, chỉ gắn cờ để Gen/Owner để ý.
SUSPICIOUS = re.compile(
    r"(bỏ qua (mọi |các )?(chỉ dẫn|hướng dẫn|lệnh)|ignore (all |previous |the above )?instructions|system prompt|"
    r"mã (otp|xác (minh|nhận))|\botp\b|chuyển (tiền|khoản)|mật khẩu|password|gửi (mã|tiền)|click (vào )?link)",
    re.IGNORECASE)
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​-‏‪-‮⁦-⁩]")


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(v: datetime | None) -> str | None:
    return v.isoformat() if v else None


# ─── kênh riêng với browser-worker ─────────────────────────────────────────────
# Chromium chạy trang không tin cậy → container `browser` KHÔNG thấy Redis chính (hàng đợi arq, khoá phiên, pub/sub
# realtime…). api/worker nói với nó qua một Redis RIÊNG (`browser-redis`, GH_BROWSER_REDIS_URL): chỉ các khoá
# `gh:browser:*` của giao thức (việc, kết quả, điều khiển, khung hình, nhịp tim). Mọi thứ khác — vé đăng nhập, lịch,
# realtime, cờ Dừng tất cả GỐC — vẫn ở Redis chính mà browser không chạm được.

_BUSES: "weakref.WeakKeyDictionary[Redis, Redis]" = weakref.WeakKeyDictionary()


def bus(redis: Redis) -> Redis:
    """Redis kênh browser đi kèm client Redis chính `redis` (tạo một lần). Chưa cấu hình (dev/test) → chính `redis`."""
    url = get_settings().browser_redis_url
    if not url:
        return redis
    b = _BUSES.get(redis)
    if b is None:
        b = _BUSES[redis] = Redis.from_url(url, decode_responses=False)
    return b


async def close_bus(redis: Redis) -> None:
    b = _BUSES.pop(redis, None)
    if b is not None:
        await b.aclose()


async def _sync_halt_mirror(redis: Redis) -> None:
    """Cờ Dừng tất cả GỐC ở Redis chính (browser không xoá được); bản sao ở kênh browser để worker thấy."""
    b = bus(redis)
    if b is redis:
        return
    raw = await redis.get(protocol.HALT_KEY)
    if raw:
        await b.set(protocol.HALT_KEY, raw)
    else:
        await b.delete(protocol.HALT_KEY)


# ─── trạng thái chung ──────────────────────────────────────────────────────────

async def halt_state(redis: Redis) -> dict[str, Any] | None:
    raw = await redis.get(protocol.HALT_KEY)
    if not raw:
        return None
    try:
        data = orjson.loads(raw)
        return data if isinstance(data, dict) else {"at": None}
    except orjson.JSONDecodeError:
        return {"at": None}


async def worker_state(redis: Redis) -> dict[str, Any] | None:
    raw = await bus(redis).get(protocol.HEARTBEAT_KEY)
    if not raw:
        return None
    try:
        data = orjson.loads(raw)
    except orjson.JSONDecodeError:
        return None
    return {"version": str(data.get("version", ""))[:40], "at": data.get("at"),
            "running": int(data.get("running", 0))} if isinstance(data, dict) else None


async def status(redis: Redis) -> dict[str, Any]:
    halt = await halt_state(redis)
    return {"halted": halt is not None, "halted_at": (halt or {}).get("at"), "worker": await worker_state(redis),
            "hard_rules": list(platforms.HARD_RULES),
            "limits": {"reads_per_day_max": READS_PER_DAY_MAX,
                       "read_min_interval_minutes": int(READ_MIN_INTERVAL.total_seconds() // 60),
                       "quiet_hours": list(QUIET_HOURS), "concurrency_per_account": 1}}


# ─── tài khoản ────────────────────────────────────────────────────────────────

ACCOUNT_COLS = """id, org_id, platform, mode, label, external_handle, status, pause_reason,
                  state_enc IS NOT NULL AS has_session, state_updated_at, last_health, risk_accepted_by,
                  risk_accepted_at, risk_version, schedule, daily_read_limit, fail_streak, last_read_at, created_at,
                  revoked_at"""


def account_out(r: Any, active_job: Any = None) -> dict[str, Any]:
    p = platforms.PLATFORMS.get(r.platform)
    return {"id": str(r.id), "platform": r.platform, "platform_name": p.name if p else r.platform, "mode": r.mode,
            "label": r.label, "external_handle": r.external_handle, "status": r.status,
            "pause_reason": r.pause_reason, "has_session": bool(r.has_session),
            "session_updated_at": _iso(r.state_updated_at), "last_health": r.last_health,
            "risk_accepted_at": _iso(r.risk_accepted_at), "risk_version": r.risk_version,
            "schedule": r.schedule or {"enabled": False, "times": []}, "daily_read_limit": r.daily_read_limit,
            "last_read_at": _iso(r.last_read_at), "created_at": _iso(r.created_at),
            "active_job": job_out(active_job) if active_job is not None else None}


async def _account(db: AsyncSession, org_id: uuid.UUID, account_id: uuid.UUID, *, lock: bool = False) -> Any:
    row = (await db.execute(text(f"""SELECT {ACCOUNT_COLS} FROM core.social_accounts
                                     WHERE org_id = :o AND id = :i AND status <> 'revoked'
                                     {"FOR UPDATE" if lock else ""}"""),
                            {"o": org_id, "i": account_id})).one_or_none()
    if row is None:
        raise not_found("Tài khoản mạng xã hội")
    return row


async def list_accounts(db: AsyncSession, org_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = (await db.execute(text(f"""SELECT {ACCOUNT_COLS} FROM core.social_accounts
                                      WHERE org_id = :o AND status <> 'revoked' ORDER BY created_at"""),
                             {"o": org_id})).all()
    out = []
    for r in rows:
        out.append(account_out(r, await active_job(db, r.id)))
    return out


async def get_account(db: AsyncSession, org_id: uuid.UUID, account_id: uuid.UUID) -> dict[str, Any]:
    r = await _account(db, org_id, account_id)
    return account_out(r, await active_job(db, r.id))


async def create_account(db: AsyncSession, redis: Redis, user: auth_service.CurrentUser, *, platform: str,
                         label: str, risk_version: str, accept_risk: bool, accept_rules: bool) -> dict[str, Any]:
    p = platforms.get(platform)
    errors: dict[str, str] = {}
    if p is None:
        errors["platform"] = "Nền tảng chưa hỗ trợ"
    if not label.strip():
        errors["label"] = "Đặt tên để nhận ra tài khoản (vd Facebook của Sếp)"
    if not accept_risk:
        errors["accept_risk"] = "Cần tích \"Tôi hiểu và chấp nhận rủi ro\" cho tài khoản này"
    if not accept_rules:
        errors["accept_rules"] = "Cần tích xác nhận đây là tài khoản thật của chính Sếp"
    if risk_version != platforms.RISK_VERSION:
        errors["risk_version"] = "Cảnh báo rủi ro đã được cập nhật — tải lại trang và đọc lại"
    if errors:
        raise field_errors(errors)
    assert p is not None
    row = (await db.execute(text(f"""
        INSERT INTO core.social_accounts (org_id, platform, mode, label, risk_accepted_by, risk_accepted_at,
                                          risk_version, created_by)
        VALUES (:o, :p, :m, :l, :u, now(), :v, :u) RETURNING {ACCOUNT_COLS}"""),
        {"o": user.org_id, "p": p.key, "m": p.mode, "l": label.strip()[:80], "u": user.id,
         "v": risk_version})).one()
    await _log(db, user, "social.account_created", row, detail={"platform": p.key, "risk_version": risk_version,
                                                                "risk_accepted": True})
    await _push(redis, user.org_id, row.id)
    return account_out(row)


async def update_account(db: AsyncSession, redis: Redis, user: auth_service.CurrentUser, account_id: uuid.UUID, *,
                         label: str | None, schedule: dict[str, Any] | None,
                         daily_read_limit: int | None) -> dict[str, Any]:
    r = await _account(db, user.org_id, account_id, lock=True)
    sets, params, changed = [], {"i": r.id}, {}
    if label is not None:
        if not label.strip():
            raise field_errors({"label": "Tên không được trống"})
        sets.append("label = :l")
        params["l"] = label.strip()[:80]
        changed["label"] = params["l"]
    if schedule is not None:
        sched = _clean_schedule(schedule)
        sets.append("schedule = CAST(:s AS jsonb)")
        params["s"] = orjson.dumps(sched).decode()
        changed["schedule"] = sched
    if daily_read_limit is not None:
        if not 1 <= daily_read_limit <= READS_PER_DAY_MAX:
            raise field_errors({"daily_read_limit": f"Từ 1 đến {READS_PER_DAY_MAX} lượt/ngày (trần cứng)"})
        sets.append("daily_read_limit = :d")
        params["d"] = daily_read_limit
        changed["daily_read_limit"] = daily_read_limit
    if sets:
        await db.execute(text(f"UPDATE core.social_accounts SET {', '.join(sets)} WHERE id = :i"), params)
        await _log(db, user, "social.account_updated", r, detail=changed)
        await _push(redis, user.org_id, r.id)
    return await get_account(db, user.org_id, r.id)


TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _clean_schedule(s: dict[str, Any]) -> dict[str, Any]:
    enabled = bool(s.get("enabled"))
    times = s.get("times") or []
    if not isinstance(times, list) or len(times) > 4:
        raise field_errors({"schedule": "Tối đa 4 mốc giờ mỗi ngày"})
    clean: list[str] = []
    for t in times:
        if not isinstance(t, str) or not TIME_RE.fullmatch(t):
            raise field_errors({"schedule": "Giờ dạng HH:MM, vd 08:00"})
        h = int(t[:2])
        if h >= QUIET_HOURS[0] or h < QUIET_HOURS[1]:
            raise field_errors({"schedule": "Không đặt lịch trong giờ nghỉ 23:00–06:00"})
        clean.append(t)
    if enabled and not clean:
        raise field_errors({"schedule": "Bật lịch thì cần ít nhất một mốc giờ"})
    return {"enabled": enabled, "times": sorted(set(clean))}


async def set_paused(db: AsyncSession, redis: Redis, user: auth_service.CurrentUser, account_id: uuid.UUID,
                     paused: bool) -> dict[str, Any]:
    r = await _account(db, user.org_id, account_id, lock=True)
    if paused:
        await db.execute(text("""UPDATE core.social_accounts SET status = 'paused', pause_reason = 'owner'
                                 WHERE id = :i"""), {"i": r.id})
        await _cancel_active(db, redis, r.id, "cancelled")
    else:
        new = "active" if r.has_session else "pending_login"
        await db.execute(text("""UPDATE core.social_accounts SET status = :s, pause_reason = NULL, fail_streak = 0
                                 WHERE id = :i"""), {"i": r.id, "s": new})
    await _log(db, user, "social.paused" if paused else "social.resumed", r)
    await _push(redis, user.org_id, r.id)
    return await get_account(db, user.org_id, r.id)


async def revoke(db: AsyncSession, redis: Redis, user: auth_service.CurrentUser, account_id: uuid.UUID) -> None:
    """Gỡ tài khoản: XOÁ phiên đã lưu (state_enc), huỷ việc đang chờ/chạy, xoá nội dung đã đọc của mọi việc cũ. Dòng
    tài khoản giữ lại ở trạng thái `revoked` (không còn dữ liệu nào) để Nhật ký hành động còn trỏ được."""
    r = await _account(db, user.org_id, account_id, lock=True)
    await _cancel_active(db, redis, r.id, "cancelled")
    await db.execute(text("""UPDATE core.social_accounts SET status = 'revoked', state_enc = NULL,
                                    state_updated_at = NULL, last_health = NULL, external_handle = NULL,
                                    revoked_at = now(), revoked_by = :u,
                                    schedule = jsonb_set(schedule, '{enabled}', 'false')
                             WHERE id = :i"""), {"i": r.id, "u": user.id})
    wiped = len((await db.execute(text("""UPDATE agent.browser_jobs SET result = NULL WHERE account_id = :i
                                          AND result IS NOT NULL RETURNING id"""), {"i": r.id})).scalars().all())
    await _log(db, user, "social.revoked", r, detail={"session_wiped": bool(r.has_session), "results_wiped": wiped})
    await _push(redis, user.org_id, r.id)


# ─── công tắc dừng khẩn ───────────────────────────────────────────────────────

async def set_halt(db: AsyncSession, redis: Redis, user: auth_service.CurrentUser, on: bool) -> dict[str, Any]:
    key = crypto.browser_key()
    if on:
        await redis.set(protocol.HALT_KEY, orjson.dumps({"at": _now().isoformat(), "by": str(user.id)}))
        await _sync_halt_mirror(redis)
        await bus(redis).publish(protocol.CONTROL_CHANNEL, orjson.dumps(
            protocol.sign(key, protocol.P_CONTROL, {"type": "halt", "ts": int(_now().timestamp())})))
        rows = (await db.execute(text("""UPDATE agent.browser_jobs SET status = 'halted', finished_at = now(),
                                                error = 'HALTED'
                                         WHERE org_id = :o AND status IN ('queued', 'running') RETURNING id"""),
                                 {"o": user.org_id})).scalars().all()
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="social.halt", target_type="browser", target_label="Dừng tất cả",
                               detail={"jobs_halted": len(rows)}, ip=user.ip)
    else:
        await redis.delete(protocol.HALT_KEY)
        await _sync_halt_mirror(redis)
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="social.halt_released", target_type="browser", target_label="Bật lại",
                               ip=user.ip)
    await realtime.publish(redis, EVENT, {"halted": on}, org_id=user.org_id)
    return await status(redis)


# ─── việc ─────────────────────────────────────────────────────────────────────

JOB_COLS = "id, account_id, kind, status, via, requested_by, result, error, created_at, started_at, finished_at"


def job_out(r: Any, *, with_result: bool = True) -> dict[str, Any]:
    return {"id": str(r.id), "account_id": str(r.account_id), "kind": r.kind, "status": r.status, "via": r.via,
            "error": r.error, "error_text": ERROR_TEXT.get(r.error or "", r.error) if r.error else None,
            "result": r.result if with_result else None, "created_at": _iso(r.created_at),
            "started_at": _iso(r.started_at), "finished_at": _iso(r.finished_at)}


ERROR_TEXT = {
    "CHECKPOINT": "Nền tảng yêu cầu xác minh (checkpoint) — hệ thống đã dừng tài khoản; Sếp bấm Đăng nhập lại để tự xử "
                  "lý trong cửa sổ trình duyệt.",
    "CAPTCHA": "Nền tảng hiện CAPTCHA — hệ thống không giải CAPTCHA; đã dừng tài khoản, Sếp bấm Đăng nhập lại để tự xử "
               "lý.",
    "LOGGED_OUT": "Phiên đăng nhập đã hết hoặc bị đăng xuất — bấm Đăng nhập lại.",
    "HALTED": "Đã dừng bằng công tắc Dừng tất cả.",
    "CANCELLED": "Đã huỷ.",
    "LOGIN_TIMEOUT": "Hết 10 phút mà chưa đăng nhập xong — bấm Đăng nhập để thử lại.",
    "WORKER_TIMEOUT": "Trình duyệt không phản hồi (dịch vụ browser chưa chạy?) — thử lại sau.",
    "BLOCKED_URL": "Trang muốn mở địa chỉ ngoài danh sách cho phép — đã chặn.",
    "SELECTOR": "Giao diện nền tảng đã đổi, chưa đọc được — cần cập nhật bộ đọc.",
    "BUSY": "Tài khoản đang có việc khác chạy — thử lại sau ít phút.",
    "ERROR": "Lỗi trình duyệt — thử lại sau.",
}


async def active_job(db: AsyncSession, account_id: uuid.UUID) -> Any:
    """Việc đang chờ/chạy của tài khoản (tối đa 1). Việc treo quá 15 phút (worker chết giữa chừng) → đóng là lỗi."""
    await db.execute(text("""UPDATE agent.browser_jobs SET status = 'failed', error = 'WORKER_TIMEOUT',
                                    finished_at = now()
                             WHERE account_id = :a AND status IN ('queued', 'running')
                               AND created_at < now() - make_interval(secs => :s)"""),
                     {"a": account_id, "s": STALE_AFTER.total_seconds()})
    return (await db.execute(text(f"""SELECT {JOB_COLS} FROM agent.browser_jobs
                                      WHERE account_id = :a AND status IN ('queued', 'running')
                                      ORDER BY created_at DESC LIMIT 1"""), {"a": account_id})).one_or_none()


async def get_job(db: AsyncSession, org_id: uuid.UUID, job_id: uuid.UUID) -> dict[str, Any]:
    r = (await db.execute(text(f"SELECT {JOB_COLS} FROM agent.browser_jobs WHERE org_id = :o AND id = :i"),
                          {"o": org_id, "i": job_id})).one_or_none()
    if r is None:
        raise not_found("Việc trình duyệt")
    return job_out(r)


async def list_jobs(db: AsyncSession, org_id: uuid.UUID, account_id: uuid.UUID,
                    limit: int = 20) -> list[dict[str, Any]]:
    await _account(db, org_id, account_id)
    rows = (await db.execute(text(f"""SELECT {JOB_COLS} FROM agent.browser_jobs WHERE org_id = :o AND account_id = :a
                                      ORDER BY created_at DESC LIMIT :n"""),
                             {"o": org_id, "a": account_id, "n": limit})).all()
    return [job_out(r, with_result=False) for r in rows]


async def _cancel_active(db: AsyncSession, redis: Redis, account_id: uuid.UUID, status: str) -> None:
    ids = (await db.execute(text("""UPDATE agent.browser_jobs SET status = :s, finished_at = now(), error = 'CANCELLED'
                                    WHERE account_id = :a AND status IN ('queued', 'running') RETURNING id"""),
                            {"a": account_id, "s": status})).scalars().all()
    key = crypto.browser_key()
    for jid in ids:
        await bus(redis).publish(protocol.CONTROL_CHANNEL, orjson.dumps(protocol.sign(
            key, protocol.P_CONTROL, {"type": "cancel", "job_id": str(jid), "ts": int(_now().timestamp())})))


async def _count_today(db: AsyncSession, account_id: uuid.UUID, kind: str) -> int:
    return int((await db.execute(text("""SELECT count(*) FROM agent.browser_jobs
                                        WHERE account_id = :a AND kind = :k AND status <> 'cancelled'
                                          AND created_at > now() - interval '24 hours'"""),
                                 {"a": account_id, "k": kind})).scalar_one())


async def _guard(db: AsyncSession, redis: Redis, r: Any) -> None:
    if await halt_state(redis) is not None:
        raise conflict("SOCIAL_HALTED", "Đang dừng tất cả việc trình duyệt — Owner bấm \"Bật lại\" trước")
    if await active_job(db, r.id) is not None:
        raise conflict("SOCIAL_BUSY", "Tài khoản này đang có một việc chạy — mỗi tài khoản chỉ chạy một việc một lúc")


async def _enqueue(db: AsyncSession, redis: Redis, *, org_id: uuid.UUID, account: Any, kind: str, via: str,
                   requested_by: uuid.UUID | None, payload: dict[str, Any]) -> uuid.UUID:
    job_id = (await db.execute(text("""INSERT INTO agent.browser_jobs (org_id, account_id, kind, via, requested_by)
                                       VALUES (:o, :a, :k, :v, :u) RETURNING id"""),
                               {"o": org_id, "a": account.id, "k": kind, "v": via, "u": requested_by})).scalar_one()
    p = platforms.PLATFORMS[account.platform]
    env = protocol.sign(crypto.browser_key(), protocol.P_JOB, {
        "v": protocol.VERSION, "id": str(job_id), "kind": kind, "org_id": str(org_id), "account_id": str(account.id),
        "platform": p.key, "domains": list(p.domains), "nonce": secrets.token_hex(16),
        "exp": int((_now() + timedelta(seconds=JOB_TTL_S)).timestamp()), "payload": payload})
    # Việc chỉ vào hàng đợi SAU KHI dòng DB đã commit — worker báo kết quả cho một job_id có thật.
    await db.commit()
    await bus(redis).xadd(protocol.JOBS_STREAM, {"m": orjson.dumps(env)}, maxlen=1000, approximate=True)
    return job_id


class _SessionUnreadable(Exception):
    """Phiên đã lưu không giải mã được bằng khoá master hiện hành (chuyển máy bằng gói cũ / đổi khoá) — F-17."""


def _sealed_state(org_id: uuid.UUID, account_id: uuid.UUID, state_enc: bytes) -> str:
    aad = protocol.account_aad(org_id, account_id)
    try:
        plain = crypto.decrypt(bytes(state_enc), f"social:{aad}".encode())
    except (InvalidTag, ValueError) as e:
        raise _SessionUnreadable from e
    return protocol.seal(crypto.browser_key(), plain, aad)


KEY_CHANGED_REASON = "key_changed"
NEEDS_LOGIN_TEXT = ("Phiên đăng nhập đã lưu không mở được trên máy này (đã chuyển máy hoặc đổi khoá) — bấm Đăng "
                    "nhập lại")


async def _seal_or_needs_login(db: AsyncSession, redis: Redis, org_id: uuid.UUID, r: Any, enc: bytes, *,
                               user: auth_service.CurrentUser | None = None) -> str:
    """`_sealed_state`, nhưng phiên không mở được → xoá phiên, tài khoản sang Cần đăng nhập lại
    (`pause_reason='key_changed'`), ghi nhật ký + báo Owner, COMMIT rồi mới ném 409 SOCIAL_NEEDS_LOGIN (để trạng
    thái không bị rollback cùng request). Không bao giờ để lọt 500 (F-17, v0.1.38)."""
    try:
        return _sealed_state(org_id, r.id, enc)
    except _SessionUnreadable:
        pass
    await db.execute(text("""UPDATE core.social_accounts SET status = 'needs_login', pause_reason = :r,
                                    state_enc = NULL, last_health = CAST(:lh AS jsonb) WHERE id = :i"""),
                     {"i": r.id, "r": KEY_CHANGED_REASON,
                      "lh": orjson.dumps({"ok": False, "at": _now().isoformat(), "state": "KEY_CHANGED"}).decode()})
    detail = {"platform": r.platform, "reason": KEY_CHANGED_REASON}
    if user is not None:
        await _log(db, user, "social.session_unreadable", r, result="failed", detail=detail)
    else:
        await actionlog.record(db, org_id=org_id, actor_type="system", actor_id="system:social",
                               action="social.session_unreadable", target_type="social_account", target_id=str(r.id),
                               target_label=r.label, result="failed", detail=detail)
    await notifications.notify(
        db, org_id, await notifications.owner_ids(db, org_id), kind="social.needs_login", redis=redis,
        title=f"{r.label}: cần đăng nhập lại",
        body="Phiên đã lưu không mở được trên máy này (đã chuyển máy hoặc đổi khoá) — mở Tài khoản mạng xã hội và "
             "bấm Đăng nhập lại.",
        link="/social")
    await db.commit()
    await _push(redis, org_id, r.id)
    log.warning("phiên mạng xã hội %s không giải mã được — chuyển sang cần đăng nhập lại", r.id)
    raise ApiError(409, "SOCIAL_NEEDS_LOGIN", NEEDS_LOGIN_TEXT)


async def _state_enc(db: AsyncSession, account_id: uuid.UUID) -> bytes | None:
    return (await db.execute(text("SELECT state_enc FROM core.social_accounts WHERE id = :i"),
                             {"i": account_id})).scalar_one_or_none()


async def request_login(db: AsyncSession, redis: Redis, user: auth_service.CurrentUser,
                        account_id: uuid.UUID) -> dict[str, Any]:
    r = await _account(db, user.org_id, account_id, lock=True)
    await _guard(db, redis, r)
    if await _count_today(db, r.id, "login") >= LOGINS_PER_DAY_MAX:
        raise ApiError(429, "SOCIAL_RATE_LIMIT", f"Đã mở đăng nhập {LOGINS_PER_DAY_MAX} lần trong 24 giờ — thử lại sau")
    p = platforms.PLATFORMS[r.platform]
    ticket = secrets.token_urlsafe(32)
    job_id = await _enqueue(db, redis, org_id=user.org_id, account=r, kind="login", via="user", requested_by=user.id,
                            payload={"ticket": ticket, "login_url": p.login_url, "timeout_s": LOGIN_TIMEOUT_S})
    await redis.set(TICKET_PREFIX + ticket, orjson.dumps({"job_id": str(job_id), "account_id": str(r.id),
                                                          "org_id": str(user.org_id), "user_id": str(user.id)}),
                    ex=LOGIN_TIMEOUT_S + 120)
    await _log(db, user, "social.login_started", r, detail={"job_id": str(job_id)})
    await db.commit()
    await _push(redis, user.org_id, r.id)
    return {"job_id": str(job_id), "ticket": ticket, "timeout_s": LOGIN_TIMEOUT_S}


async def ticket_info(redis: Redis, ticket: str) -> dict[str, Any] | None:
    raw = await redis.get(TICKET_PREFIX + ticket)
    return orjson.loads(raw) if raw else None


async def request_check(db: AsyncSession, redis: Redis, user: auth_service.CurrentUser,
                        account_id: uuid.UUID) -> dict[str, Any]:
    r = await _account(db, user.org_id, account_id, lock=True)
    enc = await _state_enc(db, r.id)
    if enc is None:
        raise conflict("SOCIAL_NO_SESSION", "Tài khoản chưa đăng nhập — bấm Đăng nhập trước")
    await _guard(db, redis, r)
    if await _count_today(db, r.id, "health") >= HEALTH_PER_DAY_MAX:
        raise ApiError(429, "SOCIAL_RATE_LIMIT", f"Đã kiểm {HEALTH_PER_DAY_MAX} lần trong 24 giờ — thử lại sau")
    sealed = await _seal_or_needs_login(db, redis, user.org_id, r, enc, user=user)
    job_id = await _enqueue(db, redis, org_id=user.org_id, account=r, kind="health", via="user", requested_by=user.id,
                            payload={"state": sealed})
    await _log(db, user, "social.check", r, detail={"job_id": str(job_id)})
    await db.commit()
    await _push(redis, user.org_id, r.id)
    return await get_job(db, user.org_id, job_id)


async def request_read(db: AsyncSession, redis: Redis, *, org_id: uuid.UUID, account_id: uuid.UUID, via: str,
                       user: auth_service.CurrentUser | None, what: list[str] | None = None) -> dict[str, Any]:
    """Xếp một lượt ĐỌC (thông báo + danh sách hội thoại). Kiểm: đang dừng tất cả, bận, trạng thái, trần/ngày,
    khoảng cách tối thiểu giữa hai lượt."""
    r = await _account(db, org_id, account_id, lock=True)
    if r.status != "active":
        raise conflict("SOCIAL_NOT_ACTIVE", {
            "paused": "Tài khoản đang tạm dừng — bấm Tiếp tục (hoặc Đăng nhập lại nếu nền tảng đòi xác minh)",
            "needs_login": "Phiên đăng nhập đã hết — bấm Đăng nhập lại",
        }.get(r.status, "Tài khoản chưa đăng nhập — bấm Đăng nhập trước"))
    enc = await _state_enc(db, r.id)
    if enc is None:
        raise conflict("SOCIAL_NO_SESSION", "Tài khoản chưa đăng nhập — bấm Đăng nhập trước")
    await _guard(db, redis, r)
    limit = min(int(r.daily_read_limit or READS_PER_DAY_MAX), READS_PER_DAY_MAX)
    if await _count_today(db, r.id, "read") >= limit:
        raise ApiError(429, "SOCIAL_RATE_LIMIT", f"Đã đọc {limit} lượt trong 24 giờ (giới hạn để giảm rủi ro khoá "
                                                 "tài khoản) — thử lại sau")
    last = (await db.execute(text("""SELECT max(created_at) FROM agent.browser_jobs WHERE account_id = :a
                                     AND kind = 'read' AND status <> 'cancelled'"""), {"a": r.id})).scalar_one()
    if last is not None and _now() - last < READ_MIN_INTERVAL:
        wait = int((READ_MIN_INTERVAL - (_now() - last)).total_seconds() // 60) + 1
        raise ApiError(429, "SOCIAL_RATE_LIMIT", f"Vừa đọc xong — đợi khoảng {wait} phút rồi đọc lại (đọc ít để giảm "
                                                 "rủi ro khoá tài khoản)")
    p = platforms.PLATFORMS[r.platform]
    kinds = [k for k in (what or list(p.read_kinds)) if k in p.read_kinds] or list(p.read_kinds)
    sealed = await _seal_or_needs_login(db, redis, org_id, r, enc, user=user)
    job_id = await _enqueue(db, redis, org_id=org_id, account=r, kind="read", via=via,
                            requested_by=user.id if user else None,
                            payload={"state": sealed, "what": kinds,
                                     "limits": {"max_pages": MAX_PAGES_PER_JOB, "max_items": MAX_ITEMS}})
    if user is not None:
        await _log(db, user, "social.read_requested", r, detail={"job_id": str(job_id), "via": via, "what": kinds})
    else:
        await actionlog.record(db, org_id=org_id, actor_type="system", actor_id="system:social-schedule",
                               action="social.read_requested", target_type="social_account", target_id=str(r.id),
                               target_label=r.label, detail={"job_id": str(job_id), "via": via, "what": kinds})
    await db.commit()
    await _push(redis, org_id, r.id)
    return await get_job(db, org_id, job_id)


async def latest_read(db: AsyncSession, org_id: uuid.UUID, account_id: uuid.UUID) -> dict[str, Any] | None:
    await _account(db, org_id, account_id)
    r = (await db.execute(text(f"""SELECT {JOB_COLS} FROM agent.browser_jobs WHERE org_id = :o AND account_id = :a
                                   AND kind = 'read' AND status = 'done' AND result IS NOT NULL
                                   ORDER BY finished_at DESC LIMIT 1"""), {"o": org_id, "a": account_id})).one_or_none()
    return job_out(r) if r is not None else None


# ─── làm sạch nội dung đọc được (dữ liệu KHÔNG tin cậy) ─────────────────────────

def _clean_text(v: Any, n: int = ITEM_TEXT_MAX) -> str:
    s = CONTROL_CHARS.sub("", str(v or ""))
    s = re.sub(r"\s+", " ", s).strip()
    return s[:n]


def _clean_link(v: Any, domains: tuple[str, ...]) -> str | None:
    s = str(v or "")
    m = re.match(r"^https://([a-z0-9.-]+)(/[^\s]*)?$", s)
    if not m:
        return None
    host = m.group(1)
    return s[:300] if any(host == d or host.endswith("." + d) for d in domains) else None


def sanitize_items(items: Any, domains: tuple[str, ...]) -> list[dict[str, Any]]:
    """Chỉ giữ trường có cấu trúc (người gửi, nội dung, thời gian, đã đọc, link trong tên miền nền tảng), cắt độ dài,
    bỏ ký tự điều khiển/đảo chiều; gắn cờ `suspicious` cho chữ giống lừa đảo/prompt injection."""
    out: list[dict[str, Any]] = []
    if not isinstance(items, list):
        return out
    for it in items[:MAX_ITEMS]:
        if not isinstance(it, dict):
            continue
        row = {"kind": "inbox" if it.get("kind") == "inbox" else "notification",
               "who": _clean_text(it.get("who"), 80) or None,
               "text": _clean_text(it.get("text")),
               "time": _clean_text(it.get("time"), 40) or None,
               "unread": bool(it.get("unread")),
               "link": _clean_link(it.get("link"), domains)}
        if not row["text"] and not row["who"]:
            continue
        row["suspicious"] = bool(SUSPICIOUS.search(f"{row['who'] or ''} {row['text']}"))
        out.append(row)
    return out


# ─── kết quả từ worker ──────────────────────────────────────────────────────────

async def handle_result(db: AsyncSession, redis: Redis, raw: Any) -> str:
    """Xử lý MỘT kết quả đã ký từ worker. Trả mã ngắn cho log/test ('ok', 'bad_sig', 'unknown_job', …)."""
    try:
        obj = orjson.loads(raw) if isinstance(raw, bytes | str) else raw
    except orjson.JSONDecodeError:
        return "bad_json"
    msg = protocol.verify(crypto.browser_key(), protocol.P_RESULT, obj)
    if msg is None:
        log.warning("bỏ kết quả browser-worker sai chữ ký")
        return "bad_sig"
    try:
        job_id = uuid.UUID(str(msg.get("job_id")))
    except ValueError:
        return "bad_job"
    job = (await db.execute(text(f"""SELECT {JOB_COLS}, org_id FROM agent.browser_jobs WHERE id = :i FOR UPDATE"""),
                            {"i": job_id})).one_or_none()
    if job is None:
        return "unknown_job"
    if str(job.account_id) != str(msg.get("account_id")) or str(job.org_id) != str(msg.get("org_id")):
        return "mismatch"
    acc = (await db.execute(text(f"SELECT {ACCOUNT_COLS} FROM core.social_accounts WHERE id = :i FOR UPDATE"),
                            {"i": job.account_id})).one()
    typ = msg.get("type")
    data: dict[str, Any] = msg["data"] if isinstance(msg.get("data"), dict) else {}
    if job.status in ("done", "failed", "halted", "cancelled"):
        return "closed"          # việc đã đóng (huỷ/dừng/hết hạn) — kết quả đến muộn bị bỏ, kể cả phiên
    if acc.status == "revoked":
        return "revoked"
    if typ == "started":
        await db.execute(text("UPDATE agent.browser_jobs SET status = 'running', started_at = now() WHERE id = :i"),
                         {"i": job.id})
        await _push(redis, job.org_id, acc.id)
        return "ok"
    state_blob = msg.get("state")
    if isinstance(state_blob, str) and typ in ("login.done", "done"):
        await _store_state(db, job.org_id, acc.id, state_blob)
    platform = platforms.PLATFORMS.get(acc.platform)
    domains = platform.domains if platform else ()
    if typ == "login.done":
        handle = _clean_text(data.get("handle"), 80) or None
        await db.execute(text("""UPDATE core.social_accounts SET status = 'active', pause_reason = NULL,
                                        fail_streak = 0, external_handle = COALESCE(:h, external_handle),
                                        last_health = CAST(:lh AS jsonb) WHERE id = :i"""),
                         {"i": acc.id, "h": handle, "lh": orjson.dumps({"ok": True, "at": _now().isoformat(),
                                                                         "state": "ok"}).decode()})
        await _close_job(db, job.id, "done", result={"logged_in": True})
        await _system_log(db, job, acc, "social.login_ok")
    elif typ == "done":
        result: dict[str, Any] = {"page_state": _clean_text(data.get("page_state"), 20) or "ok"}
        if job.kind == "read":
            items = sanitize_items(data.get("items"), domains)
            result |= {"items": items, "counts": {
                "notifications": sum(1 for i in items if i["kind"] == "notification"),
                "inbox": sum(1 for i in items if i["kind"] == "inbox"),
                "unread": sum(1 for i in items if i["unread"]),
                "suspicious": sum(1 for i in items if i["suspicious"])},
                "pages": int(data.get("pages") or 0)}
            await db.execute(text("""UPDATE core.social_accounts SET last_read_at = now(), fail_streak = 0,
                                            last_health = CAST(:lh AS jsonb) WHERE id = :i"""),
                             {"i": acc.id, "lh": orjson.dumps({"ok": True, "at": _now().isoformat(),
                                                             "state": "ok"}).decode()})
        else:
            await db.execute(text("""UPDATE core.social_accounts SET fail_streak = 0, last_health = CAST(:lh AS jsonb)
                                     WHERE id = :i"""),
                             {"i": acc.id, "lh": orjson.dumps({"ok": True, "at": _now().isoformat(),
                                                             "state": "ok"}).decode()})
        await _close_job(db, job.id, "done", result=result, cost=data.get("cost"))
        await _system_log(db, job, acc, "social.read" if job.kind == "read" else "social.health_ok",
                          detail={"counts": result.get("counts"), "via": job.via})
        if job.kind == "read" and job.via in ("schedule", "gen"):
            c = result["counts"]
            await notifications.notify(
                db, job.org_id, await _recipients(db, job), kind="social.read", redis=redis,
                title=f"{acc.label}: {c['notifications']} thông báo, {c['inbox']} hội thoại",
                body="Đã đọc xong (chỉ đọc). Hỏi Gen \"tóm tắt Facebook\" để xem điểm chính."
                     + (f" Có {c['suspicious']} mục đáng ngờ (lừa đảo/đòi mã)." if c["suspicious"] else ""),
                link="/social")
    elif typ in ("failed", "login.failed"):
        code = str(data.get("code") or "ERROR")[:40]
        if code not in ERROR_TEXT:
            code = "ERROR"
        await _close_job(db, job.id, "failed", error=code)
        await _on_failure(db, redis, job, acc, code)
    elif typ == "halted":
        await _close_job(db, job.id, "halted", error="HALTED")
    else:
        return "bad_type"
    await _push(redis, job.org_id, acc.id)
    return "ok"


async def _recipients(db: AsyncSession, job: Any) -> list[uuid.UUID]:
    owners = await notifications.owner_ids(db, job.org_id)
    return [job.requested_by] if job.requested_by in owners else owners


async def _store_state(db: AsyncSession, org_id: uuid.UUID, account_id: uuid.UUID, blob: str) -> None:
    aad = protocol.account_aad(org_id, account_id)
    try:
        plain = protocol.unseal(crypto.browser_key(), blob, aad)
        orjson.loads(plain)
    except Exception:  # noqa: BLE001 — phiên hỏng/sai khoá → bỏ, không ghi đè phiên đang có
        log.warning("bỏ phiên trình duyệt không giải mã được")
        return
    enc = crypto.encrypt(plain, f"social:{aad}".encode())
    await db.execute(text("""UPDATE core.social_accounts SET state_enc = :e, state_updated_at = now() WHERE id = :i"""),
                     {"e": enc, "i": account_id})


async def _close_job(db: AsyncSession, job_id: uuid.UUID, status: str, *, result: dict[str, Any] | None = None,
                     error: str | None = None, cost: Any = None) -> None:
    await db.execute(text("""UPDATE agent.browser_jobs SET status = :s, finished_at = now(),
                                    started_at = COALESCE(started_at, now()), result = CAST(:r AS jsonb), error = :e,
                                    cost = CAST(:c AS jsonb) WHERE id = :i"""),
                     {"s": status, "i": job_id, "r": orjson.dumps(result).decode() if result is not None else None,
                      "e": error, "c": orjson.dumps(cost).decode() if isinstance(cost, dict) else None})


async def _on_failure(db: AsyncSession, redis: Redis, job: Any, acc: Any, code: str) -> None:
    """Checkpoint/CAPTCHA → DỪNG tài khoản ngay + báo Owner (không giải, không vượt). Bị đăng xuất → cần đăng nhập lại.
    3 lỗi liên tiếp → tạm dừng."""
    if job.kind == "login" and code in ("LOGIN_TIMEOUT", "CANCELLED", "HALTED"):
        await _system_log(db, job, acc, "social.login_failed", result="failed", detail={"code": code})
        return
    streak = int(acc.fail_streak or 0) + 1
    if code in ("CHECKPOINT", "CAPTCHA"):
        new, reason = "paused", code.lower()
    elif code == "LOGGED_OUT":
        new, reason = "needs_login", "logged_out"
    elif streak >= FAIL_STREAK_PAUSE:
        new, reason = "paused", "errors"
    else:
        new, reason = acc.status, acc.pause_reason
    await db.execute(text("""UPDATE core.social_accounts SET status = :s, pause_reason = :r, fail_streak = :f,
                                    last_health = CAST(:lh AS jsonb) WHERE id = :i"""),
                     {"i": acc.id, "s": new, "r": reason, "f": streak,
                      "lh": orjson.dumps({"ok": False, "at": _now().isoformat(), "state": code}).decode()})
    await _system_log(db, job, acc, "social.auto_paused" if new != acc.status else "social.job_failed",
                      result="failed", detail={"code": code, "fail_streak": streak, "status": new})
    if new != acc.status:
        await notifications.notify(
            db, job.org_id, await notifications.owner_ids(db, job.org_id), kind="social.paused", redis=redis,
            title=f"{acc.label}: cần Sếp xử lý",
            body="3 lần lỗi liên tiếp — hệ thống đã tạm dừng tài khoản; mở Tài khoản mạng xã hội để kiểm tra."
            if reason == "errors" else ERROR_TEXT.get(code, ERROR_TEXT["ERROR"]), link="/social")


# ─── lịch đọc tự động (tắt mặc định) ─────────────────────────────────────────────

async def schedule_tick(db: AsyncSession, redis: Redis, now: datetime | None = None) -> int:
    """Mỗi phút (worker chính): tài khoản `active` có lịch bật và đúng mốc giờ (theo múi giờ tổ chức) → xếp một lượt
    đọc `via=schedule`. Không chạy 23:00–06:00, khi đang Dừng tất cả, hay khi vượt giới hạn (bỏ qua lặng lẽ)."""
    now = now or _now()
    if await halt_state(redis) is not None:
        return 0
    rows = (await db.execute(text("""SELECT a.id, a.org_id, a.schedule, o.timezone FROM core.social_accounts a
                                     JOIN core.organizations o ON o.id = a.org_id
                                     WHERE a.status = 'active' AND (a.schedule->>'enabled')::boolean"""))).all()
    n = 0
    for r in rows:
        try:
            tz = ZoneInfo(r.timezone or "Asia/Ho_Chi_Minh")
        except ZoneInfoNotFoundError:
            tz = ZoneInfo("Asia/Ho_Chi_Minh")
        local = now.astimezone(tz)
        hhmm = local.strftime("%H:%M")
        if local.hour >= QUIET_HOURS[0] or local.hour < QUIET_HOURS[1]:
            continue
        if hhmm not in (r.schedule or {}).get("times", []):
            continue
        if not await redis.set(f"gh:social:sched:{r.id}:{local.date()}:{hhmm}", "1", nx=True, ex=86400):
            continue
        try:
            await request_read(db, redis, org_id=r.org_id, account_id=r.id, via="schedule", user=None)
            n += 1
        except ApiError as e:
            await db.rollback()
            log.info("lịch đọc %s bỏ qua: %s", r.id, e.code)
        except Exception as e:  # noqa: BLE001 — F-17: một tài khoản lỗi không chặn tài khoản khác
            await db.rollback()
            log.warning("lịch đọc %s lỗi: %s", r.id, type(e).__name__)  # chỉ tên lớp lỗi — không lộ dữ liệu
    return n


# ─── Gen: đọc + chờ ngắn ────────────────────────────────────────────────────────

async def gen_read(db: AsyncSession, redis: Redis, user: auth_service.CurrentUser, account_id: str | None,
                   *, wait_s: float = 40.0, poll_s: float = 0.5) -> dict[str, Any]:
    """Tool Gen `social.read`: dùng lượt đọc xong trong 10 phút gần nhất nếu có (không tốn lượt), không thì xếp một
    lượt mới `via=gen` rồi chờ ngắn. Trả danh sách mục ĐÃ LÀM SẠCH — engine của Gen bọc toàn bộ là dữ liệu không tin
    cậy trước khi đưa model."""
    accounts = [a for a in await list_accounts(db, user.org_id)
                if account_id in (None, "", a["id"])]
    if not accounts:
        return {"error": "NO_ACCOUNT", "message": "Chưa có tài khoản mạng xã hội nào (Owner thêm ở màn Tài khoản mạng "
                                                  "xã hội)"}
    acc = next((a for a in accounts if a["status"] == "active"), accounts[0])
    aid = uuid.UUID(acc["id"])
    latest = await latest_read(db, user.org_id, aid)
    if latest and latest["finished_at"] and \
            _now() - datetime.fromisoformat(latest["finished_at"]) < RECENT_READ_REUSE:
        return _gen_view(acc, latest, reused=True)
    try:
        job = await request_read(db, redis, org_id=user.org_id, account_id=aid, via="gen", user=user)
    except ApiError as e:
        out = {"error": e.code, "message": e.title, "account": acc["label"]}
        if latest:
            out["last_read"] = _gen_view(acc, latest, reused=True)
        return out
    jid = uuid.UUID(job["id"])
    deadline = asyncio.get_running_loop().time() + wait_s
    while asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(poll_s)
        await db.rollback()          # đọc lại dữ liệu mới do consumer (phiên DB khác) ghi
        cur = await get_job(db, user.org_id, jid)
        if cur["status"] not in ("queued", "running"):
            if cur["status"] == "done":
                return _gen_view(acc, cur, reused=False)
            return {"error": cur["error"] or "FAILED", "message": cur["error_text"] or "Không đọc được",
                    "account": acc["label"]}
    return {"pending": True, "job_id": str(jid), "account": acc["label"],
            "message": "Đang đọc — xong sẽ báo chuông cho Sếp; hỏi lại Gen sau ít phút để tóm tắt."}


def _gen_view(acc: dict[str, Any], job: dict[str, Any], *, reused: bool) -> dict[str, Any]:
    res = job.get("result") or {}
    return {"account": acc["label"], "platform": acc["platform_name"], "read_at": job["finished_at"],
            "reused_recent": reused, "counts": res.get("counts"), "items": res.get("items", [])}


# ─── tiện ích ─────────────────────────────────────────────────────────────────

async def _log(db: AsyncSession, user: auth_service.CurrentUser, action: str, acc: Any, *,
               detail: dict[str, Any] | None = None, result: str = "ok") -> None:
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id, action=action,
                           target_type="social_account", target_id=str(acc.id), target_label=acc.label,
                           result=result, detail={"platform": acc.platform, **(detail or {})}, ip=user.ip)


async def _system_log(db: AsyncSession, job: Any, acc: Any, action: str, *, result: str = "ok",
                      detail: dict[str, Any] | None = None) -> None:
    """Kết quả từ worker: actor = hệ thống trình duyệt, kèm người yêu cầu (on_behalf_of) và kênh (via)."""
    await actionlog.record(db, org_id=job.org_id, actor_type="system", actor_id="system:browser-worker",
                           action=action, target_type="social_account", target_id=str(acc.id), target_label=acc.label,
                           result=result, detail={"platform": acc.platform, "job_id": str(job.id), "kind": job.kind,
                                                  "via": job.via, "on_behalf_of": str(job.requested_by)
                                                  if job.requested_by else None, **(detail or {})})


async def _push(redis: Redis, org_id: uuid.UUID, account_id: uuid.UUID) -> None:
    try:
        await realtime.publish(redis, EVENT, {"account_id": str(account_id)}, org_id=org_id)
    except Exception:  # noqa: BLE001 — màn tự tải lại định kỳ
        log.debug("không đẩy được social.update", exc_info=True)


async def consume_results(sm: Any, redis: Redis, stop: asyncio.Event, consumer: str) -> None:
    """Vòng tiêu thụ `gh:browser:results` (nhóm `api`, trên kênh browser) trong tiến trình api — mỗi kết quả một
    transaction. Kênh browser không lưu xuống đĩa: mất/khởi động lại thì tạo lại nhóm + chép lại cờ Dừng tất cả."""
    b = bus(redis)
    loop = asyncio.get_running_loop()
    ready_at: float | None = None
    while not stop.is_set():
        try:
            if ready_at is None or loop.time() - ready_at > 30:
                with contextlib.suppress(Exception):  # nhóm đã có
                    await b.xgroup_create(protocol.RESULTS_STREAM, protocol.RESULTS_GROUP, id="0", mkstream=True)
                await _sync_halt_mirror(redis)
                ready_at = loop.time()
            resp = await b.xreadgroup(protocol.RESULTS_GROUP, consumer, {protocol.RESULTS_STREAM: ">"},
                                      count=20, block=2000)
            for _stream, entries in resp or []:
                for entry_id, fields in entries:
                    raw = fields.get(b"m") or fields.get("m")
                    try:
                        async with sm() as db:
                            await handle_result(db, redis, raw)
                            await db.commit()
                    except Exception as exc:  # noqa: BLE001 — một kết quả hỏng không chặn các kết quả sau
                        log.error("xử lý kết quả trình duyệt lỗi: %s", exc)
                    await b.xack(protocol.RESULTS_STREAM, protocol.RESULTS_GROUP, entry_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — mất Redis thì thử lại
            log.warning("consumer kết quả trình duyệt: %s", exc)
            ready_at = None
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=2)
