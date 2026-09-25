"""Nền dùng chung của cụm Quan hệ & Đối tượng: hình dạng (PersonRef/GroupRef/UserRef/AgentRef), BOT + mức tự trị
riêng từng người/nhóm (`attrs.agent_id` / `attrs.autonomy_level` — cùng quy ước với `gh.biz.core.drafts`), điểm
theo bucket cho 5 hàng bộ lọc của Nhóm & Con người (`docs/handoff/01-ui-screens.md` §directory).
"""

import uuid
from typing import Any

import orjson
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

VALUE_HIGH, VALUE_MID = 500_000_000, 100_000_000
HEAT_HIGH, HEAT_MID = 80, 50


def person_ref(r: Any, prefix: str = "p") -> dict[str, Any] | None:
    pid = getattr(r, f"{prefix}_id", None)
    if pid is None:
        return None
    return {"id": str(pid), "code": getattr(r, f"{prefix}_code", None), "name": getattr(r, f"{prefix}_name", None),
            "type": getattr(r, f"{prefix}_type", None), "org_name": getattr(r, f"{prefix}_org", None)}


def group_ref(r: Any, prefix: str = "g") -> dict[str, Any] | None:
    gid = getattr(r, f"{prefix}_id", None)
    if gid is None:
        return None
    return {"id": str(gid), "code": getattr(r, f"{prefix}_code", None), "name": getattr(r, f"{prefix}_name", None),
            "channel": getattr(r, f"{prefix}_channel", None)}


def subject_ref(r: Any) -> dict[str, Any] | None:
    return person_ref(r, "p") or group_ref(r, "g")


def user_ref(id_: Any, name: str | None, role: str | None = None) -> dict[str, Any] | None:
    if id_ is None:
        return None
    return {"id": str(id_), "name": name, "role": role}


def agent_ref(id_: Any, name: str | None) -> dict[str, Any] | None:
    if id_ is None:
        return None
    return {"id": str(id_), "name": name}


def heat_bucket(value: float | None) -> str:
    if value is None:
        return "cold"
    if value >= HEAT_HIGH:
        return "high"
    if value >= HEAT_MID:
        return "mid"
    return "cold"


def value_bucket(vnd: int | None) -> str:
    if not vnd:
        return "unknown"
    if vnd >= VALUE_HIGH:
        return "high"
    if vnd >= VALUE_MID:
        return "mid"
    return "unknown"


async def set_person_bot(db: AsyncSession, person_id: uuid.UUID, *, agent_id: uuid.UUID | None,
                         set_agent: bool, autonomy_level: int | None, set_autonomy: bool) -> None:
    """BOT + mức tự trị riêng cho một người (`core.persons.attrs`) — không cột mới, cùng quy ước
    `attrs.autonomy_level` mà `gh.biz.core.drafts.effective_level` đã đọc."""
    row = (await db.execute(text("SELECT attrs FROM core.persons WHERE id = :i"), {"i": person_id})).scalar_one()
    attrs = dict(row or {})
    if set_agent:
        if agent_id is None:
            attrs.pop("agent_id", None)
        else:
            attrs["agent_id"] = str(agent_id)
    if set_autonomy:
        if autonomy_level is None:
            attrs.pop("autonomy_level", None)
        else:
            attrs["autonomy_level"] = autonomy_level
    await db.execute(text("UPDATE core.persons SET attrs = CAST(:a AS jsonb), updated_at = now() WHERE id = :i"),
                     {"a": orjson.dumps(attrs).decode(), "i": person_id})


async def set_group_bot(db: AsyncSession, group_id: uuid.UUID, *, agent_id: uuid.UUID | None,
                        autonomy_level: int | None, set_autonomy: bool) -> None:
    row = (await db.execute(text("SELECT attrs FROM core.groups WHERE id = :i"), {"i": group_id})).scalar_one()
    attrs = dict(row or {})
    if set_autonomy:
        if autonomy_level is None:
            attrs.pop("autonomy_level", None)
        else:
            attrs["autonomy_level"] = autonomy_level
    await db.execute(text("""UPDATE core.groups SET assigned_agent_id = :a, attrs = CAST(:attrs AS jsonb),
                             updated_at = now() WHERE id = :i"""),
                     {"a": agent_id, "attrs": orjson.dumps(attrs).decode(), "i": group_id})
