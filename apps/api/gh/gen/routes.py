"""/gen — khung chat Gen (docs/design/gen-v1.md §3.2). Chỉ người có Gen (cờ `gen.enabled` + vai trò) dùng được.

Truyền kết quả: WS sẵn có (`gen.step`/`gen.done`, lọc `to_user`) + `GET /gen/turns/{id}` dự phòng — lý do chọn WS
thay SSE ghi ở docs/reports/HANDOFF-v0.1.1.md mục v0.1.21.
"""

import asyncio
import uuid
from datetime import datetime
from typing import Any, Literal

import orjson
from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import service
from gh.auth.deps import current_user, require_owner
from gh.chassis import actionlog
from gh.db import DB, sessionmaker
from gh.errors import ApiError, field_errors, not_found
from gh.gen import engine, store

router = APIRouter(prefix="/gen", tags=["gen"])


async def _decider_kind(db: AsyncSession, org_id: uuid.UUID) -> str:
    has = (await db.execute(text("""SELECT 1 FROM agent.providers p
                                    JOIN agent.provider_keys k ON k.provider_id = p.id AND k.is_enabled
                                    WHERE p.org_id = :o AND p.kind = 'system_one' AND p.is_enabled LIMIT 1"""),
                            {"o": org_id})).first()
    return "jev" if has else "llm"


async def gen_user(user: service.CurrentUser = Depends(current_user), db: AsyncSession = DB) -> service.CurrentUser:
    if not store.available(await store.get_settings(db, user.org_id), user):
        raise ApiError(403, "GEN_DISABLED", "Gen chưa bật cho vai trò này")
    return user


async def _settings_out(db: AsyncSession, user: service.CurrentUser) -> dict[str, Any]:
    cfg = await store.get_settings(db, user.org_id)
    return {**cfg, "available": store.available(cfg, user), "decider": await _decider_kind(db, user.org_id)}


@router.get("/settings")
async def get_settings(user: service.CurrentUser = Depends(current_user), db: AsyncSession = DB) -> dict[str, Any]:
    return await _settings_out(db, user)


class SettingsPatch(BaseModel):
    enabled: bool | None = None
    retention_days: int | None = Field(default=None, ge=store.MIN_RETENTION, le=store.MAX_RETENTION)


@router.patch("/settings")
async def patch_settings(body: SettingsPatch, user: service.CurrentUser = Depends(require_owner),
                         db: AsyncSession = DB) -> dict[str, Any]:
    cfg = await store.get_settings(db, user.org_id)
    changes = body.model_dump(exclude_none=True)
    cfg.update(changes)
    await store.save_settings(db, user.org_id, cfg)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="gen.settings_changed", target_type="settings", target_id="gen",
                           detail=changes, ip=user.ip)
    return await _settings_out(db, user)


@router.get("/conversations")
async def conversations(user: service.CurrentUser = Depends(gen_user),
                        db: AsyncSession = DB) -> list[dict[str, Any]]:
    return await store.list_conversations(db, user)


@router.get("/conversations/{cid}/messages")
async def messages(cid: uuid.UUID, before: datetime | None = None, limit: int = Query(200, ge=1, le=500),
                   user: service.CurrentUser = Depends(gen_user), db: AsyncSession = DB) -> list[dict[str, Any]]:
    if not await store.owned(db, user, cid):
        raise not_found("Hội thoại")
    return await store.list_messages(db, cid, limit, before)


@router.delete("/conversations/{cid}", status_code=204)
async def delete_conversation(cid: uuid.UUID, user: service.CurrentUser = Depends(gen_user),
                              db: AsyncSession = DB) -> Response:
    if not await store.owned(db, user, cid):
        raise not_found("Hội thoại")
    await store.delete_conversation(db, cid)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="gen.conversation_deleted", target_type="gen_conversation", target_id=str(cid),
                           ip=user.ip)
    return Response(status_code=204)


class TurnContextIn(BaseModel):
    route: str = Field(default="/", max_length=300)
    screen_key: str | None = Field(default=None, max_length=40)
    visible_targets: list[str] = Field(default_factory=list, max_length=200)


class TurnIn(BaseModel):
    conversation_id: uuid.UUID | None = None
    text: str = Field(min_length=1, max_length=4000)
    context: TurnContextIn = Field(default_factory=TurnContextIn)


RATE_WINDOW_S, RATE_MAX_TURNS = 300, 20


def _tasks(app: Any) -> set[asyncio.Task[None]]:
    if not hasattr(app.state, "gen_tasks"):
        app.state.gen_tasks = set()
    tasks: set[asyncio.Task[None]] = app.state.gen_tasks
    return tasks


@router.post("/turns", status_code=202)
async def create_turn(body: TurnIn, request: Request, user: service.CurrentUser = Depends(gen_user),
                      db: AsyncSession = DB) -> dict[str, Any]:
    q = body.text.strip()
    if not q:
        raise field_errors({"text": "Nhập câu hỏi"})
    redis = request.app.state.redis
    rate_key = f"gen:rate:{user.id}"
    n = await redis.incr(rate_key)
    if n == 1:
        await redis.expire(rate_key, RATE_WINDOW_S)
    if n > RATE_MAX_TURNS:
        raise ApiError(429, "GEN_RATE_LIMITED", "Hỏi hơi nhanh — đợi vài phút rồi hỏi tiếp")
    lock_key = engine.lock_key(user.id)
    if not await redis.set(lock_key, "1", nx=True, ex=engine.LOCK_TTL_S):
        raise ApiError(409, "GEN_BUSY", "Gen đang trả lời câu trước — đợi xong rồi hỏi tiếp")
    try:
        return await _start_turn(body, q, request, user, db, lock_key)
    except BaseException:
        await redis.delete(lock_key)
        raise


async def _start_turn(body: TurnIn, q: str, request: Request, user: service.CurrentUser, db: AsyncSession,
                      lock_key: str) -> dict[str, Any]:
    if body.conversation_id is not None:
        if not await store.owned(db, user, body.conversation_id):
            raise not_found("Hội thoại")
        cid = body.conversation_id
    else:
        cid = await store.create_conversation(db, user, q[:60])
    turn_id = uuid.uuid4()
    await store.add_message(db, user.org_id, cid, "user", {"text": q}, turn_id)
    await actionlog.record(db, org_id=user.org_id, actor_type="agent", actor_id="gen", action="gen.turn",
                           target_type="gen_conversation", target_id=str(cid), autonomy_level=1,
                           detail={"on_behalf_of": str(user.id), "conversation_id": str(cid),
                                   "turn_id": str(turn_id), "text_digest": engine.digest(q),
                                   "screen": body.context.screen_key}, ip=user.ip)
    await db.commit()
    app = request.app
    token = request.cookies.get(service.SESSION_COOKIE, "")
    inp = engine.TurnInput(turn_id=turn_id, conversation_id=cid, text=q, route=body.context.route,
                           screen_key=body.context.screen_key, visible_targets=body.context.visible_targets)
    await app.state.redis.set(engine.turn_key(turn_id), orjson.dumps(
        {"turn_id": str(turn_id), "conversation_id": str(cid), "user_id": str(user.id), "status": "running",
         "steps": []}), ex=engine.TURN_TTL_S)
    task = asyncio.create_task(engine.run_turn(
        app=app, sm=sessionmaker(), redis=app.state.redis, router=app.state.model_router, user=user,
        session_token=token, inp=inp, decider=getattr(app.state, "gen_decider", None)), name=f"gen:{turn_id}")
    tasks = _tasks(app)
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return {"turn_id": str(turn_id), "conversation_id": str(cid)}


async def _turn_state(request: Request, user: service.CurrentUser, turn_id: uuid.UUID) -> dict[str, Any]:
    raw = await request.app.state.redis.get(engine.turn_key(turn_id))
    if raw is None:
        raise not_found("Lượt trả lời")
    state: dict[str, Any] = orjson.loads(raw)
    if state.get("user_id") != str(user.id):
        raise not_found("Lượt trả lời")
    return state


@router.get("/turns/{turn_id}")
async def get_turn(turn_id: uuid.UUID, request: Request,
                   user: service.CurrentUser = Depends(gen_user)) -> dict[str, Any]:
    state = await _turn_state(request, user, turn_id)
    return {k: state[k] for k in ("turn_id", "conversation_id", "status", "steps")}


class AckIn(BaseModel):
    step: int = Field(ge=0, le=20)
    outcome: Literal["done", "skipped", "target_missing"]


@router.post("/turns/{turn_id}/ack", status_code=204)
async def ack(turn_id: uuid.UUID, body: AckIn, request: Request, user: service.CurrentUser = Depends(gen_user),
              db: AsyncSession = DB) -> Response:
    """Web báo kết quả từng bước tour (làm xong / bỏ qua / không thấy phần tử) — số đo tỉ lệ `target_missing`."""
    state = await _turn_state(request, user, turn_id)
    await actionlog.record(db, org_id=user.org_id, actor_type="agent", actor_id="gen", action="gen.tour_step",
                           target_type="gen_turn", target_id=str(turn_id), autonomy_level=1,
                           result="failed" if body.outcome == "target_missing" else "ok",
                           detail={"on_behalf_of": str(user.id), "conversation_id": state["conversation_id"],
                                   "turn_id": str(turn_id), "step": body.step, "outcome": body.outcome}, ip=user.ip)
    return Response(status_code=204)
