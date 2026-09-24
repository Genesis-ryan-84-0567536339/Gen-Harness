"""WebSocket /api/v1/ws: đẩy sự kiện thời gian thực tới Console, lọc theo quyền người nhận.

Nguồn sự kiện: Redis pub/sub kênh `gh.ws` (api, worker, consumer đều publish được) → một bộ phát trong mỗi tiến trình
api → các kết nối WebSocket của tiến trình đó. Nhiều bản api chạy song song vẫn nhận đủ.
"""

import asyncio
import contextlib
import logging
from datetime import UTC, datetime
from typing import Any

import orjson
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from redis.asyncio import Redis

from gh.auth import rbac, service
from gh.db import sessionmaker

log = logging.getLogger("gh.ws")
router = APIRouter()

CHANNEL = "gh.ws"

# type → quyền cần có (None = mọi người đã đăng nhập).
EVENT_PERMISSION: dict[str, str | None] = {
    "raw.new": "data.read",
    "raw.state": "data.read",
    "refinery.progress": "data.read",
    "refinery.run": "data.read",
    "channel.qr": "system.read",
    "channel.status": "system.read",
    "cli.login": "system.manage",
    "header": None,
}

# Sự kiện mang nội dung tin nhắn: vai trò dưới Owner nhận bản đã che số dài (khoá cứng 8).
MASKED_EVENTS = {"raw.new"}


def register_event(type: str, permission: str | None, *, masked: bool = False) -> None:
    """Các cụm màn giai đoạn 3 khai báo sự kiện WS của mình (gọi lúc import routes). Loại chưa khai báo bị bỏ."""
    if type in EVENT_PERMISSION and EVENT_PERMISSION[type] != permission:
        raise ValueError(f"Sự kiện {type} đã khai báo với quyền khác")
    EVENT_PERMISSION[type] = permission
    if masked:
        MASKED_EVENTS.add(type)


register_event("draft.new", "action.approve")
register_event("draft.updated", "action.approve")


def mask_event(msg: dict[str, Any]) -> dict[str, Any]:
    from gh.data.common import mask_text

    data = dict(msg.get("data") or {})
    if isinstance(data.get("text"), str):
        data["text"] = mask_text(data["text"], False)
    data.pop("payload", None)
    return {**msg, "data": data}


async def publish(redis: Redis, type: str, data: dict[str, Any], *, org_id: Any = None) -> None:
    msg = {"type": type, "data": data, "at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
           "org_id": str(org_id) if org_id else None}
    await redis.publish(CHANNEL, orjson.dumps(msg, default=str))


def allowed(permissions: dict[str, str], type: str) -> bool:
    if type not in EVENT_PERMISSION:
        return False
    need = EVENT_PERMISSION[type]
    return need is None or permissions.get(need, rbac.NONE) != rbac.NONE


class Hub:
    def __init__(self, redis: Redis):
        self.redis = redis
        self.clients: dict[WebSocket, service.CurrentUser] = {}
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._pump(), name="ws-hub")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        for ws in list(self.clients):
            with contextlib.suppress(Exception):
                await ws.close(code=1001)

    async def _pump(self) -> None:
        while True:
            try:
                pubsub = self.redis.pubsub()
                await pubsub.subscribe(CHANNEL)
                async for item in pubsub.listen():
                    if item.get("type") != "message":
                        continue
                    await self.dispatch(orjson.loads(item["data"]))
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — mất Redis thì thử lại, không làm sập api
                log.warning("ws hub mất kết nối Redis: %s", exc)
                await asyncio.sleep(1)

    async def dispatch(self, msg: dict[str, Any]) -> None:
        org = msg.pop("org_id", None)
        text = orjson.dumps(msg).decode()
        masked: str | None = None
        for ws, user in list(self.clients.items()):
            if org and str(user.org_id) != org:
                continue
            if not allowed(user.permissions, msg["type"]):
                continue
            out = text
            if msg["type"] in MASKED_EVENTS and user.role_code != rbac.OWNER:
                if masked is None:
                    masked = orjson.dumps(mask_event(msg)).decode()
                out = masked
            try:
                await ws.send_text(out)
            except Exception:  # noqa: BLE001 — client đã rời
                self.clients.pop(ws, None)


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    from gh.setup.routes import console_ready

    token = ws.cookies.get(service.SESSION_COOKIE)
    async with sessionmaker()() as db:
        ready = await console_ready(db)
        user = await service.load_session(db, token) if token and ready else None
    await ws.accept()
    if not ready:
        await ws.close(code=4428)
        return
    if user is None:
        await ws.close(code=4401)
        return
    hub: Hub = ws.app.state.ws_hub
    hub.clients[ws] = user
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = orjson.loads(raw)
            except orjson.JSONDecodeError:
                continue
            if isinstance(msg, dict) and msg.get("type") == "ping":
                await ws.send_text(orjson.dumps({"type": "pong", "data": {},
                                                 "at": datetime.now(UTC).isoformat()}).decode())
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.pop(ws, None)
