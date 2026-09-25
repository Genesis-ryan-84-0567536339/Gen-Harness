"""Dependency FastAPI: người dùng hiện tại, CSRF, quyền, phiên PIN."""

from collections.abc import Awaitable, Callable

from fastapi import Depends, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import rbac, service
from gh.db import DB
from gh.errors import ApiError, forbidden, pin_required, unauthenticated

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def client_ip(request: Request) -> str | None:
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
    return user


async def current_user(user: service.CurrentUser | None = Depends(optional_user)) -> service.CurrentUser:
    if user is None:
        raise unauthenticated()
    return user


def require(permission: str, scope: str = rbac.ASSIGNED) -> Callable[..., Awaitable[service.CurrentUser]]:
    """Cần quyền `permission` với phạm vi tối thiểu `scope`. Lọc dữ liệu theo phạm vi làm ở tầng service."""

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
