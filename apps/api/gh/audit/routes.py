"""/audit — Nhật ký hành động (đọc) và kiểm chuỗi băm."""

import base64
import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import rbac, service
from gh.auth.deps import require
from gh.chassis import actionlog
from gh.db import get_db
from gh.errors import ApiError

router = APIRouter(prefix="/audit", tags=["audit"])


def _cursor_encode(at: datetime, id_: Any) -> str:
    return base64.urlsafe_b64encode(json.dumps([at.isoformat(), str(id_)]).encode()).decode()


def _cursor_decode(c: str) -> tuple[datetime, str]:
    try:
        at, id_ = json.loads(base64.urlsafe_b64decode(c.encode()))
        return datetime.fromisoformat(at), id_
    except (ValueError, TypeError) as e:
        raise ApiError(400, "BAD_CURSOR", "Con trỏ phân trang không hợp lệ") from e


async def _team_actor_ids(db: AsyncSession, user: service.CurrentUser) -> list[str]:
    rows = (await db.execute(text("""SELECT 'user:' || user_id::text FROM core.user_roles
                                     WHERE team_id IS NOT DISTINCT FROM :t AND :t IS NOT NULL"""),
                             {"t": user.team_id})).scalars().all()
    return [*rows, user.actor_id]


@router.get("")
async def list_audit(cursor: str | None = None, limit: int = Query(50, ge=1, le=200),
                     actor_type: str | None = None, action: str | None = None,
                     user: service.CurrentUser = Depends(require("audit.read")),
                     db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    where = ["a.org_id = :o"]
    params: dict[str, Any] = {"o": user.org_id, "lim": limit + 1}
    if user.permissions.get("audit.read") == rbac.TEAM:
        where.append("a.actor_id = ANY(:actors)")
        params["actors"] = await _team_actor_ids(db, user)
    if actor_type:
        where.append("a.actor_type = :at")
        params["at"] = actor_type
    if action:
        where.append("a.action LIKE :ac")
        params["ac"] = action.replace("%", "").replace("_", r"\_") + "%"
    if cursor:
        c_at, c_id = _cursor_decode(cursor)
        where.append("(a.at, a.id) < (:c_at, CAST(:c_id AS uuid))")
        params |= {"c_at": c_at, "c_id": c_id}
    rows = (await db.execute(text(f"""
        SELECT a.id, a.at, a.actor_type, a.actor_id, a.action, a.target_type, a.target_id, a.target_label,
               a.autonomy_level, a.result, a.detail,
               COALESCE(u.display_name, ag.name, a.actor_id) AS actor_label
        FROM ops.action_log a
        LEFT JOIN core.users u ON a.actor_type = 'user' AND u.id::text = substr(a.actor_id, 6)
        LEFT JOIN agent.identities ag ON a.actor_type = 'agent' AND ag.id::text = substr(a.actor_id, 7)
        WHERE {' AND '.join(where)}
        ORDER BY a.at DESC, a.id DESC LIMIT :lim"""), params)).all()  # noqa: S608 — where chỉ gồm chuỗi cố định
    more = len(rows) > limit
    rows = rows[:limit]
    items = [{"id": str(r.id), "at": r.at.isoformat(), "actor_type": r.actor_type, "actor_id": r.actor_id,
              "actor_label": r.actor_label, "action": r.action, "target_type": r.target_type,
              "target_id": r.target_id, "target_label": r.target_label, "autonomy_level": r.autonomy_level,
              "result": r.result, "detail": r.detail} for r in rows]
    return {"items": items, "next_cursor": _cursor_encode(rows[-1].at, rows[-1].id) if more and rows else None}


@router.get("/verify")
async def verify(user: service.CurrentUser = Depends(require("audit.read", rbac.ALL)),
                 db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    report = await actionlog.verify_chain(db, user.org_id)
    return {"ok": report.ok, "checked": report.checked,
            "broken_at": str(report.broken_at) if report.broken_at else None}
