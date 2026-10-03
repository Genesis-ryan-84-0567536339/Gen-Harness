"""Dependency FastAPI: người dùng hiện tại, CSRF, quyền, phiên PIN."""

import ipaddress
from collections.abc import Awaitable, Callable

from fastapi import Depends, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import rbac, service
from gh.config import get_settings
from gh.db import DB
from gh.errors import ApiError, forbidden, pin_required, unauthenticated

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


#: Caddy chép nguyên X-Forwarded-For KHÁCH gửi tới vào header này (deploy/proxy/Caddyfile, `header_up`) — Caddy
#: không tin proxy nào nên tự ghi đè X-Forwarded-For bằng IP kết nối (IP gateway docker-proxy chung cả tổ chức).
UPSTREAM_XFF = "x-gh-upstream-xff"


def _valid_ip(raw: str | None) -> str | None:
    v = (raw or "").strip()
    try:
        return str(ipaddress.ip_address(v)) if v else None
    except ValueError:
        return None


def _local_proxy_ip(request: Request) -> str | None:
    """IP khách thật khi cổng chỉ nghe 127.0.0.1 (v0.1.46, F-21): lúc đó mọi kết nối tới Caddy đều từ chính máy chủ
    (cloudflared, tailscaled, trình duyệt tại máy) ⇒ header do proxy cục bộ đặt là đáng tin, nếu không bộ đếm đăng
    nhập theo IP thành bộ đếm chung — người lạ trên Internet (Cloudflare) giữ được cả Console bị khoá.

    - chế độ cloudflare: Cf-Connecting-IP (Cloudflare tự đặt, khách không giả được);
    - còn lại: phần tử PHẢI NHẤT của X-Forwarded-For khách gửi tới Caddy — do proxy cục bộ (tailscaled/cloudflared)
      nối vào; các phần tử bên trái do khách tự gửi, giả được.
    Không có header (trình duyệt tại máy chủ) → None (dùng IP Caddy báo)."""
    s = get_settings()
    if s.bind_addr != "127.0.0.1":
        return None  # LAN/0.0.0.0 hoặc chạy ngoài compose: ai trong mạng cũng gửi được header tuỳ ý
    if s.access_mode == "cloudflare":
        cf = _valid_ip(request.headers.get("cf-connecting-ip"))
        if cf:
            return cf
    chain = request.headers.get(UPSTREAM_XFF)
    if chain:
        return _valid_ip(chain.split(",")[-1])
    return None


def client_ip(request: Request) -> str | None:
    real = _local_proxy_ip(request)
    if real:
        return real
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


async def optional_user(request: Request, db: AsyncSession = DB) -> service.CurrentUser | None:
    token = request.cookies.get(service.SESSION_COOKIE)
    if not token:
        return None
    user = await service.load_session(db, token)
    if user is None:
        return None
    # Giai đoạn 5.5 (RLS, ARCHITECTURE §8.3): đặt biến phiên cho phần còn lại của transaction request này,
    # để các policy `org_isolation` (migration 0012) lọc đúng org_id. set_config(..., true) = SET LOCAL:
    # chỉ sống trong transaction hiện tại, không rò sang connection khác khi trả về pool.
    await db.execute(text("SELECT set_config('app.org_id', :org, true)"), {"org": str(user.org_id)})
    user.ip = client_ip(request)
    if request.method not in SAFE_METHODS:
        header = request.headers.get("x-csrf-token", "")
        if not header or header != request.cookies.get(service.CSRF_COOKIE) \
                or not await service.csrf_matches(db, user.session_id, header):
            raise ApiError(403, "CSRF_INVALID", "Phiên không hợp lệ, hãy tải lại trang")
    request.state.user = user
    if user.session_renewed and user.session_expires_at is not None:
        request.state.session_renewed = user.session_expires_at
    return user


API_PREFIX = "/api/v1"


def password_change_allowed(method: str, path: str) -> bool:
    """Khi `must_change_password` (mật khẩu tạm từ `genh reset-password` hoặc lời mời thành viên): chỉ còn đăng
    nhập/đăng xuất/`/auth/*`, xem hồ sơ (`GET /account`) và đổi mật khẩu (`POST /account/password`)."""
    p = path.removeprefix(API_PREFIX)
    return p.startswith("/auth/") or p == "/account/password" or (p == "/account" and method in SAFE_METHODS)


async def current_user(request: Request,
                       user: service.CurrentUser | None = Depends(optional_user)) -> service.CurrentUser:
    if user is None:
        raise unauthenticated()
    # v0.1.20: chặn ở API (không chỉ web chuyển trang) — mọi route khác trả 403 PASSWORD_CHANGE_REQUIRED.
    if user.must_change_password and not password_change_allowed(request.method, request.url.path):
        raise ApiError(403, "PASSWORD_CHANGE_REQUIRED", "Cần đặt mật khẩu mới trước khi tiếp tục")
    return user


# F-58 (v0.1.45): quyền cấp hệ thống không có nghĩa "theo phạm vi được giao" — cấu hình hệ thống (nhà cung cấp AI,
# kênh, ranh giới, lưu giữ, sao lưu, cập nhật, MCP, plugin, agent…) là của cả tổ chức. Vai trò chỉ có
# `system.manage` = team/assigned/own KHÔNG được ghi; `require()` luôn ép phạm vi ALL cho các quyền này, bất kể nơi
# gọi truyền gì (kể cả mặc định ASSIGNED) — thống nhất mọi route mà không phải sửa từng file.
ALL_ONLY: frozenset[str] = frozenset({"system.manage"})


def require(permission: str, scope: str = rbac.ASSIGNED) -> Callable[..., Awaitable[service.CurrentUser]]:
    """Cần quyền `permission` với phạm vi tối thiểu `scope`. Lọc dữ liệu theo phạm vi làm ở tầng service.
    Quyền thuộc `ALL_ONLY` luôn cần phạm vi ALL (F-58)."""
    if permission in ALL_ONLY:
        scope = rbac.ALL

    async def dep(user: service.CurrentUser = Depends(current_user)) -> service.CurrentUser:
        have = user.permissions.get(permission, rbac.NONE)
        if have == rbac.NONE or not rbac.at_least(have, scope):
            raise forbidden(permission)
        return user

    return dep


def require_pin(operation: str) -> Callable[..., Awaitable[service.CurrentUser]]:
    """Thao tác nhạy cảm: cần phiên PIN còn hiệu lực. Không có → 423 PIN_REQUIRED."""
    if operation not in service.PIN_OPERATIONS:
        raise KeyError(f"Thao tác PIN chưa khai báo: {operation}")

    async def dep(user: service.CurrentUser = Depends(current_user)) -> service.CurrentUser:
        if not user.pin_active():
            raise pin_required()
        return user

    return dep


def require_owner(user: service.CurrentUser = Depends(current_user)) -> service.CurrentUser:
    if user.role_code != rbac.OWNER:
        raise forbidden("owner")
    return user
