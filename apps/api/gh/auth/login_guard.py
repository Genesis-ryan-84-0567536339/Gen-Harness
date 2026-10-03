"""Giới hạn đăng nhập sai (v0.1.46), đếm bằng Redis trong cửa sổ `login_fail_window_seconds` (15 phút):

- theo email: tối đa `login_fail_limit` (10) lần sai — lớp chính, chặn dò mật khẩu một tài khoản từ mọi nơi;
- theo IP: tối đa `login_ip_fail_limit` (100) lần sai — chỉ là chống dội (flood guard).

Quá ngưỡng → 429 LOGIN_RATE_LIMITED, kể cả khi mật khẩu đúng; `blocked()` trả kèm `scope` ("email" | "ip") để màn
đăng nhập nói đúng cách gỡ.

Vì sao ngưỡng IP cao hơn hẳn: ở chế độ local/tailscale/cloudflare cổng chỉ nghe 127.0.0.1 — mọi người (Tailscale
Serve, cloudflared, Owner ngồi tại máy chủ) tới Caddy qua docker-proxy từ CÙNG một IP gateway, nên bộ đếm IP thực
chất là bộ đếm chung cả tổ chức. Nếu nó cũng dừng ở 10 thì vài lần gõ nhầm mật khẩu tạm của nhân viên khoá luôn Owner,
và ai đó trên Internet (Cloudflare) giữ được cả Console bị khoá. 10 lần sai ở tài khoản A từ IP X KHÔNG được chặn
mật khẩu đúng của tài khoản B từ IP X.

Khoá: `gh:login:fail:ip:<ip>` và `gh:login:fail:email:<sha256(email chuẩn hoá)[:32]>` — không lưu email thô.
Mật khẩu đúng chỉ xoá bộ đếm email (`clear_email`), KHÔNG xoá bộ đếm IP: kẻ có một tài khoản thật không được tự
xoá bộ đếm IP của mình để dò tiếp tài khoản khác. Owner gỡ khoá bằng `genh reset-password` (xoá bộ đếm email Owner
VÀ mọi bộ đếm IP — `clear_for_owner_reset`) hoặc đợi hết cửa sổ. Owner bấm "Đặt lại mật khẩu" cho nhân viên chỉ xoá
bộ đếm email của nhân viên đó.

Mỗi khoá luôn có TTL: tạo bằng `SET NX EX` TRƯỚC khi INCR (tiến trình chết giữa chừng vẫn không để lại khoá vĩnh
viễn); khoá nào lỡ mất TTL (-1) thì `blocked()` đặt lại.

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


def _limits(ip: str | None, email: str) -> list[tuple[str, str, int]]:
    """(khoá, scope, ngưỡng) — IP trước để khi cả hai cùng chạm ngưỡng thì báo scope "ip" (lời khuyên an toàn hơn)."""
    s = get_settings()
    out: list[tuple[str, str, int]] = []
    if ip:
        out.append((ip_key(ip), "ip", s.login_ip_fail_limit))
    out.append((email_key(email), "email", s.login_fail_limit))
    return out


def keys(ip: str | None, email: str) -> list[str]:
    return [k for k, _, _ in _limits(ip, email)]


async def blocked(redis: Any, ip: str | None, email: str) -> tuple[int, str] | None:
    """(số giây còn lại — tối thiểu 1, scope "ip" | "email") nếu IP hoặc email đã chạm ngưỡng; không thì None."""
    window = get_settings().login_fail_window_seconds
    try:
        worst: tuple[int, str] | None = None
        for k, scope, limit in _limits(ip, email):
            raw = await redis.get(k)
            if raw is not None and int(raw) >= limit:
                ttl = int(await redis.ttl(k))
                if ttl == -1:  # khoá lỡ mất TTL — đặt lại để không khoá vĩnh viễn
                    await redis.expire(k, window)
                left = max(1, ttl if ttl > 0 else window)
                if worst is None:
                    worst = (left, scope)
                else:
                    worst = (max(worst[0], left), worst[1])
        return worst
    except _FAIL_OPEN as e:
        log.warning("Redis lỗi khi kiểm giới hạn đăng nhập — cho đăng nhập tiếp (%s)", type(e).__name__)
        return None


async def record_failure(redis: Any, ip: str | None, email: str) -> None:
    window = get_settings().login_fail_window_seconds
    try:
        for k in keys(ip, email):
            # Tạo khoá kèm TTL trước (nguyên tử), rồi mới tăng: không bao giờ có khoá đếm thiếu TTL.
            await redis.set(k, 0, nx=True, ex=window)
            await redis.incr(k)
    except _FAIL_OPEN as e:
        log.warning("Redis lỗi khi ghi lần đăng nhập sai (%s)", type(e).__name__)


async def clear_email(redis: Any, email: str) -> None:
    """Xoá bộ đếm theo email (KHÔNG xoá khoá IP). Redis lỗi chỉ log."""
    try:
        await redis.delete(email_key(email))
    except _FAIL_OPEN as e:
        log.warning("Redis lỗi khi xoá bộ đếm đăng nhập (%s)", type(e).__name__)


async def clear_for_owner_reset(redis: Any, email: str) -> None:
    """`genh reset-password` (chạy trên máy chủ ⇒ Owner thật): xoá bộ đếm email Owner và MỌI bộ đếm IP — sau
    Tailscale Serve/Docker rootless mọi người chung một IP nguồn, chỉ xoá email thì Owner vẫn bị khoá theo IP.
    Redis lỗi chỉ log."""
    try:
        doomed = [email_key(email)]
        async for k in redis.scan_iter(match="gh:login:fail:ip:*", count=500):
            doomed.append(k)
        await redis.delete(*doomed)
    except _FAIL_OPEN as e:
        log.warning("Redis lỗi khi gỡ khoá đăng nhập (%s)", type(e).__name__)


async def log_once(redis: Any, email: str) -> bool:
    """True nếu đây là lần chặn đầu trong cửa sổ (để chỉ ghi Action Log một dòng). Redis lỗi → False."""
    try:
        ok = await redis.set("gh:login:blocked-log:" + _email_hash(email), "1", nx=True,
                             ex=get_settings().login_fail_window_seconds)
        return bool(ok)
    except _FAIL_OPEN:
        return False
