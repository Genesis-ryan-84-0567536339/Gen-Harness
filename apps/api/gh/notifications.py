"""/notifications — chuông thông báo ở header (v0.1.23, Đợt B6; bảng core.notifications — migration 0017).

Mỗi thông báo thuộc đúng MỘT người nhận; API chỉ đọc/đánh dấu thông báo của chính người đang đăng nhập (kể cả
Owner cũng không đọc thông báo của người khác). Ghi thông báo qua `notify()` trong cùng transaction với việc gây
ra nó; sự kiện WebSocket `notification.new` chỉ gửi tới người nhận (`to_user`) để chuông cập nhật ngay.
"""

import asyncio
import logging
import uuid
from collections.abc import Iterable
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession

from gh import realtime
from gh.auth import service
from gh.auth.deps import current_user
from gh.chassis import actionlog
from gh.db import DB

log = logging.getLogger("gh.notifications")
router = APIRouter(prefix="/notifications", tags=["notifications"])

EVENT = "notification.new"
# Người nhận lọc bằng `to_user` ở Hub.dispatch; không cần quyền riêng.
realtime.register_event(EVENT, None)

MAX_TITLE, MAX_BODY, MAX_LINK = 160, 1000, 300
_PENDING = "gh_pending_notifications"
_tasks: set[asyncio.Task[None]] = set()


async def _publish_all(redis: Any, items: list[tuple[uuid.UUID, uuid.UUID, dict[str, Any]]]) -> None:
    for org_id, uid, item in items:
        try:
            await realtime.publish(redis, EVENT, item, org_id=org_id, to_user=uid)
        except Exception:  # noqa: BLE001 — chuông vẫn thấy khi tải lại
            log.warning("Không đẩy được notification.new", exc_info=True)


def _after_commit(session: Any) -> None:
    items = session.info.pop(_PENDING, None) or []
    if not items:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    by_redis: dict[int, tuple[Any, list[tuple[uuid.UUID, uuid.UUID, dict[str, Any]]]]] = {}
    for r, o, u, it in items:
        by_redis.setdefault(id(r), (r, []))[1].append((o, u, it))
    for r, batch in by_redis.values():
        task = loop.create_task(_publish_all(r, batch))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)


def _after_rollback(session: Any) -> None:
    session.info.pop(_PENDING, None)


def _queue_publish(db: AsyncSession, redis: Any, org_id: uuid.UUID, uid: uuid.UUID, item: dict[str, Any]) -> None:
    """Chỉ đẩy WS SAU KHI transaction commit (rollback → bỏ), để client không nhận thông báo chưa/không tồn tại."""
    sync = db.sync_session
    if not event.contains(sync, "after_commit", _after_commit):
        event.listen(sync, "after_commit", _after_commit)
        event.listen(sync, "after_rollback", _after_rollback)
    pending: list[tuple[Any, uuid.UUID, uuid.UUID, dict[str, Any]]] = sync.info.setdefault(_PENDING, [])
    pending.append((redis, org_id, uid, item))


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat().replace("+00:00", "Z") if dt else None


def _out(r: Any) -> dict[str, Any]:
    return {"id": str(r.id), "kind": r.kind, "title": r.title, "body": r.body, "link": r.link,
            "created_at": _iso(r.created_at), "read": r.read_at is not None}


async def owner_ids(db: AsyncSession, org_id: uuid.UUID) -> list[uuid.UUID]:
    """Các Owner còn hoạt động của tổ chức — người nhận mặc định của thông báo hệ thống (sao lưu …)."""
    rows = (await db.execute(text("""
        SELECT u.id FROM core.users u JOIN core.user_roles ur ON ur.user_id = u.id
        JOIN core.roles r ON r.id = ur.role_id
        WHERE u.org_id = :o AND u.is_active AND u.deleted_at IS NULL AND r.code = 'owner'"""),
        {"o": org_id})).scalars().all()
    return list(rows)


async def notify(db: AsyncSession, org_id: uuid.UUID, user_ids: Iterable[uuid.UUID], *, kind: str, title: str,
                 body: str = "", link: str | None = None, redis: Any = None) -> list[dict[str, Any]]:
    """Ghi một thông báo cho từng người nhận; có `redis` thì đẩy `notification.new` SAU KHI `db` commit (rollback
    → không đẩy; lỗi đẩy không làm hỏng việc chính — chuông vẫn thấy khi tải lại)."""
    out: list[dict[str, Any]] = []
    for uid in dict.fromkeys(user_ids):
        row = (await db.execute(text("""
            INSERT INTO core.notifications (org_id, user_id, kind, title, body, link)
            VALUES (:o, :u, :k, :t, :b, :l)
            RETURNING id, kind, title, body, link, created_at, read_at"""),
            {"o": org_id, "u": uid, "k": kind, "t": title[:MAX_TITLE], "b": body[:MAX_BODY],
             "l": (link or None) and link[:MAX_LINK]})).one()
        item = _out(row)
        out.append(item)
        if redis is not None:
            _queue_publish(db, redis, org_id, uid, item)
    return out


async def _unread(db: AsyncSession, user: service.CurrentUser) -> int:
    n: int = (await db.execute(text("""SELECT count(*) FROM core.notifications
                                       WHERE org_id = :o AND user_id = :u AND read_at IS NULL"""),
                               {"o": user.org_id, "u": user.id})).scalar_one()
    return n


@router.get("")
async def list_notifications(limit: int = Query(20, ge=1, le=100),
                             user: service.CurrentUser = Depends(current_user),
                             db: AsyncSession = DB) -> dict[str, Any]:
    rows = (await db.execute(text("""
        SELECT id, kind, title, body, link, created_at, read_at FROM core.notifications
        WHERE org_id = :o AND user_id = :u ORDER BY created_at DESC, id DESC LIMIT :l"""),
        {"o": user.org_id, "u": user.id, "l": limit})).all()
    return {"items": [_out(r) for r in rows], "unread": await _unread(db, user)}


class ReadIn(BaseModel):
    """`ids` rỗng/không gửi = đánh dấu TẤT CẢ đã đọc."""
    ids: list[uuid.UUID] | None = Field(default=None, max_length=200)


@router.post("/read")
async def mark_read(body: ReadIn, user: service.CurrentUser = Depends(current_user),
                    db: AsyncSession = DB) -> dict[str, Any]:
    params: dict[str, Any] = {"o": user.org_id, "u": user.id}
    where = "org_id = :o AND user_id = :u AND read_at IS NULL"
    if body.ids:
        where += " AND id = ANY(:ids)"
        params["ids"] = list(body.ids)
    await db.execute(text(f"UPDATE core.notifications SET read_at = now() WHERE {where}"), params)  # noqa: S608
    actionlog.exempt()  # thao tác riêng tư, không phải hành động nghiệp vụ — không ghi Nhật ký
    return {"unread": await _unread(db, user)}
