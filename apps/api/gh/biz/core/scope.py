"""Phạm vi dữ liệu (ScopeFilter) cho mọi màn kinh doanh — tầng service, không chỉ route (ARCHITECTURE §8.3).

Quyền = năng lực × phạm vi (`all | team | assigned | none`). Màn gọi `scope_for(db, user, "profile.read")` một lần,
rồi ghép biểu thức SQL do `Scope` sinh vào truy vấn của mình:

    sc = await scope_for(db, user, "profile.read")
    where, params = sc.person_sql("p")
    rows = await db.execute(text(f"SELECT … FROM core.persons p WHERE p.org_id = :o AND {where}"), {"o": …, **params})

Đối tượng ngoài phạm vi phải trả 404 (không lộ là có tồn tại): dùng `ensure_person` / `ensure_group` / `not_found`.
"""

import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import rbac, service
from gh.errors import ApiError, forbidden


def not_found(what: str = "Đối tượng") -> ApiError:
    return ApiError(404, "NOT_FOUND", f"{what} không tồn tại hoặc ngoài phạm vi của bạn")


@dataclass(frozen=True)
class Scope:
    org_id: uuid.UUID
    user_id: uuid.UUID
    level: str                                   # all | team | assigned | none
    users: tuple[uuid.UUID, ...] = field(default=())   # người dùng mà phạm vi bao phủ (mình, hoặc cả team)

    @property
    def is_all(self) -> bool:
        return self.level == rbac.ALL

    def _params(self) -> dict[str, Any]:
        return {"scope_users": list(self.users)}

    def person_sql(self, alias: str = "p") -> tuple[str, dict[str, Any]]:
        """Biểu thức boolean trên một dòng `core.persons` có bí danh `alias`."""
        if self.is_all:
            return "TRUE", {}
        if self.level == rbac.NONE:
            return "FALSE", {}
        return (f"({alias}.owner_user_id = ANY(:scope_users) OR EXISTS ("
                f"SELECT 1 FROM core.assignments sa WHERE sa.subject_type = 'person' AND sa.subject_id = {alias}.id"
                f" AND sa.active_to IS NULL AND sa.user_id = ANY(:scope_users)))"), self._params()

    def person_id_sql(self, column: str) -> tuple[str, dict[str, Any]]:
        """Biểu thức trên một cột chứa id người (vd `o.person_id`); NULL chỉ thấy khi phạm vi `all`."""
        if self.is_all:
            return "TRUE", {}
        where, params = self.person_sql("sp")
        return f"EXISTS (SELECT 1 FROM core.persons sp WHERE sp.id = {column} AND {where})", params

    def group_sql(self, alias: str = "g") -> tuple[str, dict[str, Any]]:
        """Biểu thức boolean trên một dòng `core.groups` có bí danh `alias`."""
        if self.is_all:
            return "TRUE", {}
        if self.level == rbac.NONE:
            return "FALSE", {}
        return (f"EXISTS (SELECT 1 FROM core.assignments sa WHERE sa.subject_type = 'group'"
                f" AND sa.subject_id = {alias}.id AND sa.active_to IS NULL AND sa.user_id = ANY(:scope_users))"
                ), self._params()

    def group_id_sql(self, column: str) -> tuple[str, dict[str, Any]]:
        if self.is_all:
            return "TRUE", {}
        where, params = self.group_sql("sg")
        return f"EXISTS (SELECT 1 FROM core.groups sg WHERE sg.id = {column} AND {where})", params

    def user_sql(self, column: str) -> tuple[str, dict[str, Any]]:
        """Biểu thức trên một cột chứa id người dùng (người phụ trách, người được giao, người tạo)."""
        if self.is_all:
            return "TRUE", {}
        if self.level == rbac.NONE:
            return "FALSE", {}
        return f"{column} = ANY(:scope_users)", self._params()

    def subject_sql(self, type_col: str, id_col: str) -> tuple[str, dict[str, Any]]:
        """Biểu thức trên cặp cột (subject_type, subject_id) kiểu person | group | khác (khác → chỉ `all`)."""
        if self.is_all:
            return "TRUE", {}
        pw, pp = self.person_id_sql(id_col)
        gw, gp = self.group_id_sql(id_col)
        return f"(({type_col} = 'person' AND {pw}) OR ({type_col} = 'group' AND {gw}))", {**pp, **gp}


async def team_users(db: AsyncSession, team_id: uuid.UUID) -> tuple[uuid.UUID, ...]:
    """Thành viên của team và các team con."""
    rows = (await db.execute(text("""
        WITH RECURSIVE t AS (SELECT id FROM core.teams WHERE id = :t
                             UNION SELECT c.id FROM core.teams c JOIN t ON c.parent_id = t.id)
        SELECT DISTINCT ur.user_id FROM core.user_roles ur JOIN t ON ur.team_id = t.id"""), {"t": team_id})).all()
    return tuple(r.user_id for r in rows)


async def scope_for(db: AsyncSession, user: service.CurrentUser, permission: str) -> Scope:
    """Phạm vi của người gọi cho `permission`. Không có quyền → 403."""
    level = user.permissions.get(permission, rbac.NONE)
    if level == rbac.NONE:
        raise forbidden(permission)
    users: tuple[uuid.UUID, ...] = (user.id,)
    if level == rbac.TEAM:
        members = await team_users(db, user.team_id) if user.team_id else ()
        users = tuple(dict.fromkeys((user.id, *members)))
    return Scope(org_id=user.org_id, user_id=user.id, level=level, users=users)


async def ensure_person(db: AsyncSession, sc: Scope, person_id: uuid.UUID) -> None:
    where, params = sc.person_sql("p")
    ok = (await db.execute(text(f"SELECT 1 FROM core.persons p WHERE p.id = :i AND p.org_id = :o AND {where}"),
                           {"i": person_id, "o": sc.org_id, **params})).first()  # noqa: S608 — biểu thức nội bộ
    if ok is None:
        raise not_found("Người")


async def ensure_group(db: AsyncSession, sc: Scope, group_id: uuid.UUID) -> None:
    where, params = sc.group_sql("g")
    ok = (await db.execute(text(f"SELECT 1 FROM core.groups g WHERE g.id = :i AND g.org_id = :o AND {where}"),
                           {"i": group_id, "o": sc.org_id, **params})).first()  # noqa: S608 — biểu thức nội bộ
    if ok is None:
        raise not_found("Nhóm")


async def ensure_subject(db: AsyncSession, sc: Scope, subject_type: str | None, subject_id: uuid.UUID | None) -> None:
    if sc.is_all:
        return
    if subject_type == "person" and subject_id:
        await ensure_person(db, sc, subject_id)
    elif subject_type == "group" and subject_id:
        await ensure_group(db, sc, subject_id)
    else:
        raise not_found()
