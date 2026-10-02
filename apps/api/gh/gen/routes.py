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

from gh.auth import rbac, service
from gh.auth.deps import current_user, require_owner
from gh.chassis import actionlog
from gh.db import DB, sessionmaker
from gh.errors import ApiError, conflict, field_errors, forbidden, not_found, pin_required
from gh.gen import engine, proposals, store

router = APIRouter(prefix="/gen", tags=["gen"])

#: Khoá phụ của lỗi endpoint nội bộ được chuyển tiếp nguyên cho web khi xác nhận đề xuất Gen thất bại.
_PASSTHROUGH_ERROR_KEYS = ("error_id", "locked_until", "attempts_left")


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


class FeedbackIn(BaseModel):
    conversation_id: uuid.UUID
    turn_id: uuid.UUID
    rating: Literal["helpful", "not_helpful"]


@router.put("/feedback")
async def put_feedback(body: FeedbackIn, user: service.CurrentUser = Depends(gen_user),
                       db: AsyncSession = DB) -> dict[str, Any]:
    """v0.1.41 (F-84): "Hữu ích / Không hữu ích" cho một câu trả lời (hoặc Bản tin Gen) trong hội thoại của chính
    mình — chấm lại thì đổi đánh giá. Số đo riêng tư ⇒ không ghi Nhật ký (như đánh dấu đã đọc thông báo)."""
    if not await store.owned(db, user, body.conversation_id):
        raise not_found("Hội thoại")
    kind = await store.set_feedback(db, user, body.conversation_id, body.turn_id, body.rating)
    if kind is None:
        raise not_found("Câu trả lời")
    actionlog.exempt()
    return {"turn_id": str(body.turn_id), "rating": body.rating, "kind": kind}


@router.delete("/feedback/{turn_id}", status_code=204)
async def delete_feedback(turn_id: uuid.UUID, user: service.CurrentUser = Depends(gen_user),
                          db: AsyncSession = DB) -> Response:
    """Bỏ chấm (chỉ đánh giá của chính mình)."""
    await store.delete_feedback(db, user, turn_id)
    actionlog.exempt()
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


# ── Gen v2 (A4): đề xuất thao tác có xác nhận — gh.gen.proposals ──

@router.get("/assignees")
async def assignees(user: service.CurrentUser = Depends(gen_user), db: AsyncSession = DB) -> dict[str, Any]:
    """Người có thể được giao việc (tên + vai trò, KHÔNG email) — cho tool `staff.list` và ô chọn trên thẻ đề xuất."""
    if user.permissions.get("queue.act", rbac.NONE) == rbac.NONE:
        raise forbidden("queue.act")
    rows = (await db.execute(text("""
        SELECT u.id, u.display_name, r.name AS role_name FROM core.users u
        LEFT JOIN core.user_roles ur ON ur.user_id = u.id LEFT JOIN core.roles r ON r.id = ur.role_id
        WHERE u.org_id = :o AND u.is_active AND u.deleted_at IS NULL
        ORDER BY lower(u.display_name) LIMIT 200"""), {"o": user.org_id})).all()
    return {"items": [{"id": str(r.id), "name": r.display_name, "role": r.role_name, "me": r.id == user.id}
                      for r in rows]}


async def _owned_proposal(request: Request, user: service.CurrentUser, pid: uuid.UUID) -> dict[str, Any]:
    p = await proposals.load(request.app.state.redis, pid)
    if p is None or p.get("user_id") != str(user.id) or p.get("org_id") != str(user.org_id):
        raise not_found("Đề xuất (có thể đã hết hạn)")
    if p.get("status") != "pending":
        raise conflict("GEN_PROPOSAL_DECIDED", "Đề xuất này đã được xác nhận hoặc đã huỷ")
    return p


async def _log_apart(user: service.CurrentUser, action: str, result: str, p: dict[str, Any],
                     **detail: Any) -> None:
    """Ghi Action Log ở transaction riêng — request đang lỗi (rollback) vẫn để lại dấu vết bị chặn/thất bại."""
    async with sessionmaker()() as s:
        await s.execute(text("SELECT set_config('app.org_id', :o, true)"), {"o": str(user.org_id)})
        await actionlog.record(s, org_id=user.org_id, actor_type="user", actor_id=user.actor_id, action=action,
                               target_type="gen_proposal", target_id=p["id"], result=result,
                               detail={"via": "gen", "proposal_id": p["id"], "type": p["type"],
                                       "turn_id": p["turn_id"], **detail}, ip=user.ip)
        await s.commit()


class ConfirmIn(BaseModel):
    """Các trường người dùng đã sửa trên thẻ (bỏ trống = giữ nguyên như Gen đề xuất)."""
    fields: dict[str, Any] = Field(default_factory=dict)


@router.post("/proposals/{pid}/confirm")
async def confirm_proposal(pid: uuid.UUID, request: Request, body: ConfirmIn | None = None,
                           user: service.CurrentUser = Depends(gen_user), db: AsyncSession = DB) -> dict[str, Any]:
    body = body or ConfirmIn()
    redis = request.app.state.redis
    p = await _owned_proposal(request, user, pid)
    ptype: str = p["type"]
    spec = proposals.SPECS[ptype]
    locked = {k for k, v in body.fields.items() if k not in spec.editable and p["fields"].get(k) != v}
    if locked:
        raise field_errors({k: "Không sửa được trường này" for k in sorted(locked)})
    merged = {**p["fields"], **{k: v for k, v in body.fields.items() if k in spec.editable}}
    tz = await proposals.org_tz(db, user.org_id)
    try:
        fields = proposals.normalize(ptype, merged, tz)
    except ValueError as e:
        raise field_errors({"fields": str(e)}) from e
    target = proposals.target_of(ptype, fields)
    err = proposals.permission_error(user.permissions, ptype, target)
    if err:
        await _log_apart(user, "gen.proposal_confirmed", "blocked", p, reason=err)
        raise forbidden(err)
    if proposals.requires_pin(target) and not user.pin_active():
        raise pin_required()
    try:
        lab = await proposals.labels(db, user, ptype, fields)
    except ValueError as e:
        raise field_errors({"fields": str(e)}) from e
    if not await redis.set(proposals.claim_key(pid), "1", nx=True, ex=proposals.CLAIM_TTL_S):
        raise conflict("GEN_PROPOSAL_BUSY", "Đề xuất đang được thực hiện")
    try:
        call = await proposals.plan_call(db, user, ptype, fields)
        # Đóng transaction của request ngoài TRƯỚC khi gọi nội bộ: request ngoài có thể đang giữ khoá dòng
        # core.sessions (gia hạn phiên / trượt phiên PIN trong load_session) mà request nội bộ cũng UPDATE → hai bên
        # chờ nhau (Postgres không thấy vòng chờ qua ứng dụng). Commit cũng trả connection về pool trong lúc chờ.
        await db.commit()
        status, res = await proposals.call_as_user(request.app, dict(request.cookies),
                                                   request.headers.get("x-csrf-token", ""), call, ip=user.ip)
        # Transaction mới cho phần ghi còn lại → đặt lại biến RLS (set_config(..., true) chỉ sống trong 1 transaction).
        await db.execute(text("SELECT set_config('app.org_id', :o, true)"), {"o": str(user.org_id)})
    except BaseException:
        await redis.delete(proposals.claim_key(pid))
        raise
    if status >= 400:
        await redis.delete(proposals.claim_key(pid))
        err_body = res if isinstance(res, dict) else {}
        await _log_apart(user, "gen.proposal_confirmed", "blocked" if status in (403, 404, 423) else "failed", p,
                         endpoint=f"{call.method} {call.path}", status=status, code=err_body.get("code"))
        extra = {"errors": err_body["errors"]} if isinstance(err_body.get("errors"), dict) else {}
        # Giữ các khoá phụ người dùng cần thấy: mã lỗi của 500 INTERNAL (gửi hỗ trợ), giờ mở khoá/số lần còn lại
        # của PIN. Chỉ danh sách trắng kiểu vô hướng — không chuyển tiếp khoá lạ từ phản hồi nội bộ.
        extra.update({k: err_body[k] for k in _PASSTHROUGH_ERROR_KEYS
                      if isinstance(err_body.get(k), (str, int)) and not isinstance(err_body.get(k), bool)})
        raise ApiError(status, str(err_body.get("code") or "GEN_PROPOSAL_FAILED"),
                       str(err_body.get("title") or "Không thực hiện được đề xuất"), err_body.get("detail"), **extra)
    result = proposals.result_of(call, fields, res)
    edited = fields != p["fields"]
    patch = {"status": "confirmed", "fields": fields, "labels": lab,
             "summary": proposals.summary(ptype, fields, lab, tz), "result": result}
    p.update(patch)
    await proposals.save(redis, p)
    await store.update_proposal_step(db, uuid.UUID(p["conversation_id"]), uuid.UUID(p["turn_id"]), p["id"], patch)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="gen.proposal_confirmed", target_type=result["type"], target_id=result.get("id"),
                           target_label=str(fields.get("title") or lab.get("item") or "")[:200] or None,
                           detail={"via": "gen", "proposal_id": p["id"], "type": ptype, "turn_id": p["turn_id"],
                                   "conversation_id": p["conversation_id"], "edited": edited,
                                   "endpoint": f"{call.method} {call.path}", "fields_digest": engine.digest(fields)},
                           ip=user.ip)
    return proposals.public(p)


@router.post("/proposals/{pid}/cancel")
async def cancel_proposal(pid: uuid.UUID, request: Request, user: service.CurrentUser = Depends(gen_user),
                          db: AsyncSession = DB) -> dict[str, Any]:
    p = await _owned_proposal(request, user, pid)
    if await request.app.state.redis.exists(proposals.claim_key(pid)):
        raise conflict("GEN_PROPOSAL_BUSY", "Đề xuất đang được thực hiện")
    p["status"] = "cancelled"
    await proposals.save(request.app.state.redis, p)
    await store.update_proposal_step(db, uuid.UUID(p["conversation_id"]), uuid.UUID(p["turn_id"]), p["id"],
                                     {"status": "cancelled"})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="gen.proposal_cancelled", target_type="gen_proposal", target_id=p["id"],
                           detail={"via": "gen", "proposal_id": p["id"], "type": p["type"], "turn_id": p["turn_id"],
                                   "conversation_id": p["conversation_id"]}, ip=user.ip)
    return proposals.public(p)
