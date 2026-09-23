"""Nhà máy ứng dụng FastAPI."""

import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from redis.asyncio import Redis
from sqlalchemy import text

from gh import __version__
from gh.audit.routes import router as audit_router
from gh.auth.routes import router as auth_router
from gh.bootstrap import bootstrap
from gh.chassis.bus import EventBus
from gh.chassis.plugins import Manifest, PluginManager
from gh.config import get_settings
from gh.db import dispose_engine, sessionmaker
from gh.errors import ApiError, JsonResponse, api_error_handler, validation_error_handler
from gh.middleware import ActionLogGuard, SetupGate
from gh.plugins_api.routes import router as plugins_router
from gh.setup.routes import router as setup_router
from gh.shell.routes import router as shell_router

log = logging.getLogger("gh.app")


async def _persist_plugin(package: str, change: dict[str, Any]) -> None:
    async with sessionmaker()() as db:
        if change.get("_deleted"):
            await db.execute(text("DELETE FROM ops.plugins WHERE package = :p AND origin <> 'core'"), {"p": package})
        elif "is_enabled" in change:
            await db.execute(text("UPDATE ops.plugins SET is_enabled = :e WHERE package = :p"),
                             {"e": change["is_enabled"], "p": package})
        await db.commit()


async def _breaker_sink(package: str, state: str, reason: str | None) -> None:
    async with sessionmaker()() as db:
        await db.execute(text("""INSERT INTO ops.breaker_events (plugin_id, state, reason)
                                 SELECT id, :s, :r FROM ops.plugins WHERE package = :p"""),
                         {"s": state, "r": reason, "p": package})
        await db.commit()


async def build_plugin_manager(bus: EventBus | None) -> PluginManager:
    pm = PluginManager(bus, persist=_persist_plugin, breaker_sink=_breaker_sink)
    async with sessionmaker()() as db:
        rows = (await db.execute(text("SELECT origin, is_enabled, manifest, settings FROM ops.plugins"))).all()
    for r in rows:
        try:
            pm.register(Manifest.model_validate(r.manifest), origin=r.origin, enabled=r.is_enabled,
                        settings=r.settings or {})
        except Exception as exc:  # noqa: BLE001 — manifest hỏng không làm sập API
            log.error("Bỏ qua plugin có manifest lỗi: %s", exc)
    await pm.load_all()
    return pm


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    s = get_settings()
    async with sessionmaker()() as db:
        result = await bootstrap(db)
        await db.commit()
    app.state.org_id = result.org_id
    app.state.console_ready = None
    app.state.redis = Redis.from_url(s.redis_url, decode_responses=False)
    app.state.bus = EventBus(app.state.redis, s.stream_maxlen)
    app.state.plugins = await build_plugin_manager(app.state.bus)
    app.state.plugins.start_control_listener()
    log.info("Gen-Harness API %s sẵn sàng", __version__)
    try:
        yield
    finally:
        await app.state.plugins.shutdown()
        await app.state.redis.aclose()
        await dispose_engine()


def create_app(*, with_lifespan: bool = True) -> FastAPI:
    app = FastAPI(title="Gen-Harness API", version=__version__, default_response_class=JsonResponse,
                  lifespan=lifespan if with_lifespan else None, docs_url="/api/v1/docs",
                  openapi_url="/api/v1/openapi.json")
    app.add_exception_handler(ApiError, api_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    for r in (auth_router, setup_router, shell_router, audit_router, plugins_router):
        app.include_router(r, prefix="/api/v1")
    # Thứ tự: middleware thêm sau bọc ngoài cùng.
    app.add_middleware(ActionLogGuard)
    app.add_middleware(SetupGate)
    return app


def configure_logging() -> None:
    class JsonFormatter(logging.Formatter):
        def format(self, record: logging.LogRecord) -> str:
            return json.dumps({"level": record.levelname, "logger": record.name, "msg": record.getMessage()},
                              ensure_ascii=False)

    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter() if get_settings().is_production else logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
