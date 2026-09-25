"""Middleware ASGI: chặn Console khi chưa thiết lập (428), bảo đảm mọi request ghi có dòng Action Log."""

import logging
from typing import Any

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from gh.chassis import actionlog
from gh.db import sessionmaker
from gh.errors import ApiError, _body

log = logging.getLogger("gh.http")

API_PREFIX = "/api/v1"
# /auth/me KHÔNG được miễn: trước khi thiết lập xong, câu trả lời đúng là 428 (đi tới /setup), không phải 401.
SETUP_EXEMPT = ("/setup", "/auth/login", "/auth/logout", "/auth/pin", "/health", "/ready", "/docs", "/openapi.json")
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


async def _problem(send: Send, err: ApiError) -> None:
    import orjson

    body = orjson.dumps(_body(err.status, err.code, err.title, err.detail, err.extra))
    await send({"type": "http.response.start", "status": err.status,
                "headers": [(b"content-type", b"application/problem+json"),
                            (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


class SetupGate:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith(API_PREFIX):
            return await self.app(scope, receive, send)
        sub = scope["path"][len(API_PREFIX):]
        if sub.startswith(SETUP_EXEMPT):
            return await self.app(scope, receive, send)
        app_state = scope["app"].state
        if not getattr(app_state, "console_ready", None):
            from gh.setup.routes import console_ready

            async with sessionmaker()() as db:
                app_state.console_ready = await console_ready(db) or None
        if not app_state.console_ready:
            return await _problem(send, ApiError(428, "SETUP_REQUIRED", "Hệ thống chưa thiết lập xong"))
        return await self.app(scope, receive, send)


class ActionLogGuard:
    """Mọi request ghi thành công mà route chưa ghi Action Log → ghi một dòng chung (không để lọt)."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] not in WRITE_METHODS:
            return await self.app(scope, receive, send)
        marker: list[Any] = []
        token = actionlog.request_marker.set(marker)
        status = {"code": 500}

        async def _send(msg: Message) -> None:
            if msg["type"] == "http.response.start":
                status["code"] = msg["status"]
            await send(msg)

        try:
            await self.app(scope, receive, _send)
        finally:
            actionlog.request_marker.reset(token)
        if 200 <= status["code"] < 300 and not marker:
            user = scope.get("state", {}).get("user")
            if user is None:
                return
            try:
                async with sessionmaker()() as db:
                    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                                           action=f"http.{scope['method'].lower()}", target_type="route",
                                           target_id=scope["path"], ip=user.ip)
                    await db.commit()
            except Exception:  # noqa: BLE001
                log.exception("Không ghi được Action Log cho %s %s", scope["method"], scope["path"])
