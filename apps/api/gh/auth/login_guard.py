"""Giới hạn đăng nhập sai (v0.1.46): tối đa `login_fail_limit` (10) lần sai / `login_fail_window_seconds` (15 phút)
theo IP và theo email, đếm bằng Redis. Quá ngưỡng → 429 LOGIN_RATE_LIMITED, kể cả khi mật khẩu đúng.

Khoá: `gh:login:fail:ip:<ip>` và `gh:login:fail:email:<sha256(email chuẩn hoá)[:32]>` — không lưu email thô.
Mật khẩu đúng chỉ xoá bộ đếm email (`clear_email`), KHÔNG xoá bộ đếm IP: kẻ có một tài khoản thật không được tự
xoá bộ đếm IP của mình để dò tiếp tài khoản khác.

Rủi ro đã biết: sau Tailscale Serve / Docker rootless mọi người dùng có thể chung một IP nguồn ⇒ bộ đếm IP thành
chung cho cả nhóm; giới hạn theo email là lớp chính. Owner gỡ khoá bằng `genh reset-password` hoặc đợi 15 phút.

Redis lỗi → fail-open (log một dòng, không kèm email, cho đăng nhập tiếp): app do Owner tự host; Redis chết thì api
đã báo sức khoẻ, không nên khoá Owner ra ngoài vì hạ tầng.

TOTP/2FA: để sau (chưa làm trong đợt này).
"""

import hashlib
import logging
from typing import Any

from redis.exceptions import RedisError

from gh.config import get_settings

log = logging.getLogger("gh.auth.login_guard")

_FAIL_OPEN = (RedisError, OSError)


def _email_hash(email: str) -> str:
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()[:32]


def email_key(email: str) -> str:
    return "gh:login:fail:email:" + _email_hash(email)


def ip_key(ip: str) -> str:
    return "gh:login:fail:ip:" + ip[:64]


def keys(ip: str | None, email: str) -> list[str]:
    return ([ip_key(ip)] if ip else []) + [email_key(email)]


async def blocked(redis: Any, ip: str | None, email: str) -> int | None:
    """Số giây còn lại nếu IP hoặc email đã chạm ngưỡng (tối thiểu 1); không thì None."""
    s = get_settings()
    try:
        worst: int | None = None
        for k in keys(ip, email):
            raw = await redis.get(k)
            if raw is not None and int(raw) >= s.login_fail_limit:
                ttl = int(await redis.ttl(k))
                left = max(1, ttl if ttl > 0 else s.login_fail_window_seconds)
                worst = left if worst is None else max(worst, left)
        return worst
    except _FAIL_OPEN as e:
        log.warning("Redis lỗi khi kiểm giới hạn đăng nhập — cho đăng nhập tiếp (%s)", type(e).__name__)
        return None


async def record_failure(redis: Any, ip: str | None, email: str) -> None:
    window = get_settings().login_fail_window_seconds
    try:
        for k in keys(ip, email):
            if int(await redis.incr(k)) == 1:
                await redis.expire(k, window)
    except _FAIL_OPEN as e:
        log.warning("Redis lỗi khi ghi lần đăng nhập sai (%s)", type(e).__name__)


async def clear_email(redis: Any, email: str) -> None:
    """Xoá bộ đếm theo email (KHÔNG xoá khoá IP). Redis lỗi chỉ log."""
    try:
        await redis.delete(email_key(email))
    except _FAIL_OPEN as e:
        log.warning("Redis lỗi khi xoá bộ đếm đăng nhập (%s)", type(e).__name__)


async def log_once(redis: Any, email: str) -> bool:
    """True nếu đây là lần chặn đầu trong cửa sổ (để chỉ ghi Action Log một dòng). Redis lỗi → False."""
    try:
        ok = await redis.set("gh:login:blocked-log:" + _email_hash(email), "1", nx=True,
                             ex=get_settings().login_fail_window_seconds)
        return bool(ok)
    except _FAIL_OPEN:
        return False
