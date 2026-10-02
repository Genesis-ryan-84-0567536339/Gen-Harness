"""Ô chọn người / trợ lý dùng chung cho các thao tác giao/gán (v0.1.35, F-1): Hộp thư «Giao cho người khác»,
Vụ việc «Gán người xử lý», Nhóm & Con người «Gán BOT trực nhóm», bộ lọc «Phụ trách» ở Bản đồ quan hệ.

Chỉ lộ `id` + tên hiển thị — không email, không vai trò. Không dùng lại `/users` (cần roles.manage),
`/gen/assignees` (tắt theo GEN_DISABLED) hay `/agents` (cần system.read ALL).
"""

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import rbac, service
from gh.auth.deps import current_user, require
from gh.db import DB
from gh.errors import forbidden

router = APIRouter(prefix="/pickers", tags=["pickers"])


def _any_of(*permissions: str) -> Callable[..., Awaitable[service.CurrentUser]]:
    """Cần ít nhất MỘT trong các quyền (phạm vi bất kỳ khác NONE); cả ba đều NONE → 403 forbidden("queue.act").

    Thêm `profile.read` (ngoài queue.act / opportunity.write của kế hoạch) vì bộ lọc 'Phụ trách' ở Bản đồ quan hệ
    cần cho Auditor — lệch có chủ đích so với kế hoạch; chỉ lộ tên hiển thị.
    """

    async def dep(user: service.CurrentUser = Depends(current_user)) -> service.CurrentUser:
        if all(user.permissions.get(p, rbac.NONE) == rbac.NONE for p in permissions):
            raise forbidden(permissions[0])
        return user

    return dep


USERS = _any_of("queue.act", "opportunity.write", "profile.read")


@router.get("/users")
async def picker_users(user: service.CurrentUser = Depends(USERS), db: AsyncSession = DB) -> dict[str, Any]:
    rows = (await db.execute(text("""
        SELECT u.id, u.display_name FROM core.users u
        WHERE u.org_id = :o AND u.is_active AND u.deleted_at IS NULL
        ORDER BY lower(u.display_name) LIMIT 500"""), {"o": user.org_id})).all()
    return {"items": [{"id": str(r.id), "name": r.display_name, "me": r.id == user.id} for r in rows]}


@router.get("/agents")
async def picker_agents(user: service.CurrentUser = Depends(require("profile.write")),
                        db: AsyncSession = DB) -> dict[str, Any]:
    rows = (await db.execute(text("""SELECT id, name FROM agent.identities WHERE org_id = :o AND is_enabled
                                     ORDER BY lower(name)"""), {"o": user.org_id})).all()
    return {"items": [{"id": str(r.id), "name": r.name} for r in rows]}
