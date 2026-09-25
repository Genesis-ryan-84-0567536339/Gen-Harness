"""/setup — trình thiết lập Owner 12 bước (docs/handoff/06). Giai đoạn 1: bước 1–3; giai đoạn 2: bước 4–7, 12."""

import hmac
import json
import re
import uuid
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import rbac, service
from gh.auth.deps import client_ip, optional_user
from gh.auth.routes import set_session_cookies
from gh.chassis import actionlog
from gh.crypto import hash_secret, token_digest
from gh.data_api.routes import RuleIn, ScheduleIn, create_rule, save_schedule, save_weights
from gh.db import DB
from gh.errors import ApiError, conflict, field_errors, forbidden, unauthenticated
from gh.refinery import presets
from gh.refinery.runner import load_schedule
from gh.system_api.routes import GroupPatch, update_group

router = APIRouter(prefix="/setup", tags=["setup"])

# (số, khoá, tên, bắt buộc, làm được từ giai đoạn)
STEPS: tuple[tuple[int, str, str, bool, int], ...] = (
    (1, "welcome", "Chào mừng", True, 1),
    (2, "owner", "Tài khoản Owner", True, 1),
    (3, "org", "Tổ chức & xưng hô", True, 1),
    (4, "brain", "Bộ não AI", True, 2),
    (5, "channels", "Kết nối kênh", True, 2),
    (6, "groups", "Chọn nhóm lắng nghe", True, 2),
    (7, "refinery", "Sàng lọc dữ liệu", True, 2),
    (8, "agent", "Agent đầu tiên", True, 3),
    (9, "autonomy", "Tự trị & ranh giới", True, 3),
    (10, "team", "Mời đội ngũ", False, 4),
    (11, "backup", "Sao lưu", False, 4),
    (12, "finish", "Hoàn tất", True, 2),
)
CURRENT_PHASE = 2
CONSOLE_STEPS = ("1", "2", "3")    # xong 3 bước này thì Console mở (các bước sau làm tiếp được)
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
CURRENCIES = ("VND", "USD", "EUR", "JPY", "SGD", "THB", "CNY", "KRW")


class Step1In(BaseModel):
    token: str | None = Field(default=None, max_length=200)
    language: Literal["vi", "en"] = "vi"
    mode: Literal["empty", "sample"] = "empty"


class Step2In(BaseModel):
    token: str = Field(max_length=200)
    display_name: str = Field(max_length=120)
    email: str = Field(max_length=320)
    password: str = Field(max_length=1024)
    pin: str = Field(max_length=16)
    pin_confirm: str = Field(max_length=16)


class Step3In(BaseModel):
    org_name: str = Field(max_length=160)
    timezone: str = Field(default="Asia/Ho_Chi_Minh", max_length=64)
    currency: str = Field(default="VND", max_length=3)
    self_name: str = Field(max_length=40)
    bot_calls_me: str = Field(max_length=60)


async def _row(db: AsyncSession) -> Any:
    row = (await db.execute(text("""SELECT s.org_id, s.step, s.completed, s.setup_token_hash, s.finished_at
                                    FROM ops.setup_state s ORDER BY s.org_id LIMIT 1 FOR UPDATE"""))).one_or_none()
    if row is None:
        raise ApiError(503, "NOT_BOOTSTRAPPED", "Hệ thống đang khởi tạo, thử lại sau ít giây")
    return row


def state_payload(row: Any) -> dict[str, Any]:
    completed = row.completed or {}
    done = completed.get("steps", {})
    steps = []
    for n, key, title, required, phase in STEPS:
        status = done.get(str(n)) or ("doing" if n == row.step else "todo")
        steps.append({"n": n, "key": key, "title": title, "required": required, "status": status,
                      "available": phase <= CURRENT_PHASE})
    return {"finished": row.finished_at is not None, "current_step": row.step, "steps": steps,
            "language": completed.get("language", "vi"), "mode": completed.get("mode"),
            "owner_created": done.get("2") == "done",
            "console_ready": all(done.get(k) == "done" for k in CONSOLE_STEPS)}


async def console_ready(db: AsyncSession) -> bool:
    completed = (await db.execute(text("SELECT completed FROM ops.setup_state ORDER BY org_id LIMIT 1"))).scalar()
    done = (completed or {}).get("steps", {})
    return all(done.get(k) == "done" for k in CONSOLE_STEPS)


async def _save(db: AsyncSession, org_id: uuid.UUID, completed: dict[str, Any], step: int) -> Any:
    await db.execute(text("UPDATE ops.setup_state SET completed = CAST(:c AS jsonb), step = :s WHERE org_id = :o"),
                     {"c": json.dumps(completed), "s": step, "o": org_id})
    return await _row(db)


def _next_open_step(done: dict[str, str], after: int) -> int:
    for n, *_ in STEPS:
        if n > after and done.get(str(n)) not in ("done", "skipped"):
            return n
    return 12


def _check_token(row: Any, token: str | None) -> None:
    if row.setup_token_hash is None or not token or \
            not hmac.compare_digest(bytes(row.setup_token_hash), token_digest(token.strip())):
        raise ApiError(403, "SETUP_TOKEN_INVALID", "Mã thiết lập không đúng hoặc đã hết hiệu lực")


def _not_finished(row: Any) -> None:
    if row.finished_at is not None:
        raise conflict("SETUP_FINISHED", "Hệ thống đã thiết lập xong")


def _owner_of(row: Any, user: service.CurrentUser | None) -> service.CurrentUser:
    if user is None:
        raise unauthenticated()
    if user.org_id != row.org_id or user.role_code != rbac.OWNER:
        raise forbidden("owner")
    return user


@router.get("/state")
async def get_state(db: AsyncSession = DB) -> dict[str, Any]:
    return state_payload(await _row(db))


@router.put("/steps/1")
async def step1(body: Step1In, request: Request, db: AsyncSession = DB,
                user: service.CurrentUser | None = Depends(optional_user)) -> dict[str, Any]:
    row = await _row(db)
    _not_finished(row)
    completed = dict(row.completed or {})
    done = dict(completed.get("steps", {}))
    if done.get("2") == "done":
        actor = _owner_of(row, user)
        actor_type, actor_id = "user", actor.actor_id
    else:
        _check_token(row, body.token)
        actor_type, actor_id = "system", "system:setup"
    done["1"] = "done"
    completed |= {"steps": done, "language": body.language, "mode": body.mode}
    await actionlog.record(db, org_id=row.org_id, actor_type=actor_type, actor_id=actor_id,
                           action="setup.step_saved", target_type="setup_step", target_id="1",
                           target_label="Chào mừng", detail={"language": body.language, "mode": body.mode},
                           ip=client_ip(request))
    return state_payload(await _save(db, row.org_id, completed, row.step if done.get("2") == "done" else 2))


@router.put("/steps/2")
async def step2(body: Step2In, request: Request, response: Response,
                db: AsyncSession = DB) -> dict[str, Any]:
    row = await _row(db)
    _not_finished(row)
    completed = dict(row.completed or {})
    done = dict(completed.get("steps", {}))
    if done.get("2") == "done":
        raise conflict("OWNER_EXISTS", "Tài khoản Owner đã được tạo")
    _check_token(row, body.token)
    if done.get("1") != "done":
        raise conflict("STEP_ORDER", "Cần hoàn thành bước 1 trước")

    errors: dict[str, str] = {}
    name, email = body.display_name.strip(), body.email.strip().lower()
    if not name:
        errors["display_name"] = "Nhập tên hiển thị"
    if not EMAIL_RE.match(email):
        errors["email"] = "Email chưa đúng định dạng"
    if len(body.password) < 12:
        errors["password"] = "Mật khẩu cần ít nhất 12 ký tự"
    if not service.valid_pin(body.pin):
        errors["pin"] = "PIN gồm đúng 6 chữ số"
    elif body.pin != body.pin_confirm:
        errors["pin_confirm"] = "Hai lần nhập PIN không khớp"
    if errors:
        raise field_errors(errors)

    user_id = (await db.execute(text("""
        INSERT INTO core.users (org_id, email, display_name, password_hash, pin_hash)
        VALUES (:o, :e, :n, :p, :pin) RETURNING id"""),
        {"o": row.org_id, "e": email, "n": name, "p": hash_secret(body.password),
         "pin": hash_secret(body.pin)})).scalar_one()
    role_id = (await db.execute(text("SELECT id FROM core.roles WHERE org_id = :o AND code = 'owner'"),
                                {"o": row.org_id})).scalar_one()
    await db.execute(text("INSERT INTO core.user_roles (user_id, role_id) VALUES (:u, :r)"),
                     {"u": user_id, "r": role_id})
    ip = client_ip(request)
    new = await service.create_session(db, user_id, ip=ip, user_agent=request.headers.get("user-agent"))
    set_session_cookies(response, new)
    # Mã thiết lập hết hiệu lực ngay khi có Owner.
    await db.execute(text("UPDATE ops.setup_state SET setup_token_hash = NULL WHERE org_id = :o"), {"o": row.org_id})
    await actionlog.record(db, org_id=row.org_id, actor_type="user", actor_id=f"user:{user_id}",
                           action="setup.owner_created", target_type="user", target_id=str(user_id),
                           target_label=name, ip=ip)
    done["2"] = "done"
    completed["steps"] = done
    return state_payload(await _save(db, row.org_id, completed, 3))


@router.put("/steps/3")
async def step3(body: Step3In, request: Request, db: AsyncSession = DB,
                user: service.CurrentUser | None = Depends(optional_user)) -> dict[str, Any]:
    row = await _row(db)
    _not_finished(row)
    owner = _owner_of(row, user)
    errors: dict[str, str] = {}
    org_name, self_name, bot_calls = body.org_name.strip(), body.self_name.strip(), body.bot_calls_me.strip()
    currency = body.currency.strip().upper()
    if not org_name:
        errors["org_name"] = "Nhập tên tổ chức"
    try:
        ZoneInfo(body.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        errors["timezone"] = "Múi giờ không hợp lệ"
    if currency not in CURRENCIES:
        errors["currency"] = "Tiền tệ chưa hỗ trợ"
    if not self_name:
        errors["self_name"] = "Nhập cách Sếp tự xưng"
    if not bot_calls:
        errors["bot_calls_me"] = "Nhập cách agent gọi Sếp"
    if errors:
        raise field_errors(errors)
    await db.execute(text("UPDATE core.organizations SET name = :n, timezone = :tz, currency = :c WHERE id = :o"),
                     {"n": org_name, "tz": body.timezone, "c": currency, "o": row.org_id})
    await db.execute(text("UPDATE core.users SET addressing = addressing || CAST(:a AS jsonb) WHERE id = :u"),
                     {"a": json.dumps({"self": self_name, "bot_calls_me": bot_calls}), "u": owner.id})
    await actionlog.record(db, org_id=row.org_id, actor_type="user", actor_id=owner.actor_id,
                           action="setup.step_saved", target_type="setup_step", target_id="3",
                           target_label="Tổ chức & xưng hô",
                           detail={"org_name": org_name, "timezone": body.timezone, "currency": currency},
                           ip=client_ip(request))
    completed = dict(row.completed or {})
    done = dict(completed.get("steps", {}))
    done["3"] = "done"
    completed["steps"] = done
    request.app.state.console_ready = None  # xoá bộ nhớ đệm của middleware
    return state_payload(await _save(db, row.org_id, completed, max(row.step, _next_open_step(done, 3))))


@router.post("/steps/{n}/skip")
async def skip(n: int, request: Request, db: AsyncSession = DB,
               user: service.CurrentUser | None = Depends(optional_user)) -> dict[str, Any]:
    row = await _row(db)
    _not_finished(row)
    owner = _owner_of(row, user)
    step = next((s for s in STEPS if s[0] == n), None)
    if step is None:
        raise ApiError(404, "NOT_FOUND", "Không có bước này")
    if step[3]:
        raise conflict("STEP_REQUIRED", f"Bước {n} là bắt buộc, không bỏ qua được")
    completed = dict(row.completed or {})
    done = dict(completed.get("steps", {}))
    if done.get(str(n)) != "done":
        done[str(n)] = "skipped"
    completed["steps"] = done
    await actionlog.record(db, org_id=row.org_id, actor_type="user", actor_id=owner.actor_id,
                           action="setup.step_skipped", target_type="setup_step", target_id=str(n),
                           target_label=step[2], ip=client_ip(request))
    return state_payload(await _save(db, row.org_id, completed,
                                     _next_open_step(done, n) if row.step == n else row.step))


# ─── Bước 4–7, 12 (giai đoạn 2) ─────────────────────────────────────────────

class Step4In(BaseModel):
    provider_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)


class Step6Group(GroupPatch):
    id: uuid.UUID


class Step6In(BaseModel):
    groups: list[Step6Group] = Field(default_factory=list, max_length=500)


class Step7In(BaseModel):
    interval_seconds: int = Field(ge=60, le=86400)
    count_threshold: int = Field(ge=1, le=100000)
    min_confidence: float = Field(ge=0, le=1)
    rule_codes: list[str] = Field(default_factory=list, max_length=50)
    weights: list[dict[str, Any]] = Field(default_factory=list, max_length=20)


def incomplete(msg: str) -> ApiError:
    return conflict("STEP_INCOMPLETE", msg)


async def _mark_done(db: AsyncSession, request: Request, row: Any, owner: service.CurrentUser, n: int,
                     detail: dict[str, Any] | None = None) -> dict[str, Any]:
    completed = dict(row.completed or {})
    done = dict(completed.get("steps", {}))
    done[str(n)] = "done"
    completed["steps"] = done
    title = next(s[2] for s in STEPS if s[0] == n)
    await actionlog.record(db, org_id=row.org_id, actor_type="user", actor_id=owner.actor_id,
                           action="setup.step_saved", target_type="setup_step", target_id=str(n),
                           target_label=title, detail=detail, ip=client_ip(request))
    step = _next_open_step(done, n) if row.step <= n else row.step
    return state_payload(await _save(db, row.org_id, completed, step))


async def _owner_step(db: AsyncSession, user: service.CurrentUser | None) -> tuple[Any, service.CurrentUser]:
    row = await _row(db)
    _not_finished(row)
    owner = _owner_of(row, user)
    if not await console_ready(db):
        raise conflict("STEP_ORDER", "Cần hoàn thành bước 1–3 trước")
    return row, owner


@router.put("/steps/4")
async def step4(body: Step4In, request: Request, db: AsyncSession = DB,
                user: service.CurrentUser | None = Depends(optional_user)) -> dict[str, Any]:
    """Bộ não AI: thứ tự ưu tiên chuyển dự phòng. Cần ít nhất một nhà cung cấp đã gọi thử thành công."""
    row, owner = await _owner_step(db, user)
    ids = list(dict.fromkeys(body.provider_ids))
    found = (await db.execute(text("""
        SELECT p.id, p.kind, p.auth_state, COALESCE((p.last_test->>'ok')::boolean, false) AS tested,
               EXISTS (SELECT 1 FROM agent.cli_profiles c WHERE c.provider_id = p.id AND c.is_active) AS cli_ok
        FROM agent.providers p WHERE p.org_id = :o AND p.id = ANY(:ids)"""),
        {"o": row.org_id, "ids": ids})).all()
    if len(found) != len(ids):
        raise field_errors({"provider_ids": "Có nhà cung cấp không tồn tại"})
    ready = [p for p in found if (p.cli_ok if p.kind == "antigravity_cli" else p.tested and p.auth_state == "ok")]
    if not ready:
        raise incomplete("Cần ít nhất một nhà cung cấp đã gọi thử thành công, hoặc Antigravity CLI đã đăng nhập")
    for rank, pid in enumerate(ids, start=1):
        await db.execute(text("UPDATE agent.providers SET failover_rank = :r, is_enabled = true WHERE id = :i"),
                         {"r": rank, "i": pid})
    return await _mark_done(db, request, row, owner, 4, {"provider_ids": [str(i) for i in ids]})


@router.put("/steps/5")
async def step5(request: Request, db: AsyncSession = DB,
                user: service.CurrentUser | None = Depends(optional_user)) -> dict[str, Any]:
    """Kết nối kênh: cần ít nhất một kênh đang hoạt động (quét QR xong)."""
    row, owner = await _owner_step(db, user)
    live = (await db.execute(text("""
        SELECT array_agg(DISTINCT c.type) FROM core.channel_sessions s JOIN core.channels c ON c.id = s.channel_id
        WHERE c.org_id = :o AND s.state = 'active' AND s.ended_at IS NULL"""), {"o": row.org_id})).scalar()
    if not live:
        raise incomplete("Cần kết nối ít nhất một kênh (quét mã QR) trước khi tiếp tục")
    return await _mark_done(db, request, row, owner, 5, {"channels": sorted(live)})


@router.put("/steps/6")
async def step6(body: Step6In, request: Request, db: AsyncSession = DB,
                user: service.CurrentUser | None = Depends(optional_user)) -> dict[str, Any]:
    """Chọn nhóm lắng nghe: lưu chế độ từng nhóm; cần ít nhất một nhóm khác \"tắt\"."""
    row, owner = await _owner_step(db, user)
    for g in body.groups:
        await update_group(db, request.app.state.redis, owner, g.id,
                           GroupPatch.model_validate(g.model_dump(exclude={"id"})))
    listening = int((await db.execute(text("""SELECT count(*) FROM core.groups
                                              WHERE org_id = :o AND listen_mode NOT IN ('off', 'paused')"""),
                                      {"o": row.org_id})).scalar_one())
    if listening == 0:
        raise incomplete("Cần bật lắng nghe ít nhất một nhóm")
    return await _mark_done(db, request, row, owner, 6, {"listening": listening})


@router.get("/rule-presets")
async def rule_presets(db: AsyncSession = DB,
                       user: service.CurrentUser | None = Depends(optional_user)) -> list[dict[str, Any]]:
    _owner_of(await _row(db), user)
    return [{k: p[k] for k in ("code", "name", "kind", "threshold", "enabled", "conditions", "outputs",
                               "prompt_hint")} for p in presets.PRESETS]


@router.put("/steps/7")
async def step7(body: Step7In, request: Request, db: AsyncSession = DB,
                user: service.CurrentUser | None = Depends(optional_user)) -> dict[str, Any]:
    """Sàng lọc: lịch chạy (chu kỳ HOẶC ngưỡng), bộ quy tắc khởi đầu, trọng số chấm điểm."""
    row, owner = await _owner_step(db, user)
    known = {p["code"]: p for p in presets.PRESETS}
    unknown = [c for c in body.rule_codes if c not in known]
    if unknown:
        raise field_errors({"rule_codes": f"Không có quy tắc {', '.join(unknown)}"})
    current = await load_schedule(db, row.org_id)
    await save_schedule(db, row.org_id, ScheduleIn(interval_seconds=body.interval_seconds,
                                                   count_threshold=body.count_threshold,
                                                   batch_size=current.batch_size, min_confidence=body.min_confidence))
    if body.weights:
        await save_weights(db, row.org_id, body.weights)
    existing = {r.code: r.id for r in (await db.execute(text("SELECT code, id FROM refinery.rules WHERE org_id = :o"),
                                                            {"o": row.org_id})).all()}
    for code, p in known.items():
        on = code in body.rule_codes
        if code in existing:
            await db.execute(text("UPDATE refinery.rules SET is_enabled = :e, updated_at = now() WHERE id = :i"),
                             {"e": on, "i": existing[code]})
        else:
            rin = RuleIn(name=p["name"], kind=p["kind"], conditions=p["conditions"], outputs=p["outputs"],
                         threshold=p["threshold"], prompt_hint=p.get("prompt_hint"))
            await create_rule(db, row.org_id, rin, owner.id, code=code, enabled=on)
    return await _mark_done(db, request, row, owner, 7,
                            {"interval_seconds": body.interval_seconds, "count_threshold": body.count_threshold,
                             "min_confidence": body.min_confidence, "rule_codes": body.rule_codes})


@router.get("/first-run")
async def first_run(db: AsyncSession = DB,
                    user: service.CurrentUser | None = Depends(optional_user)) -> dict[str, Any]:
    """Số liệu lượt sàng lọc đầu tiên cho bước 12 (cập nhật trực tiếp qua WS `refinery.progress`)."""
    row = await _row(db)
    _owner_of(row, user)
    c = (await db.execute(text("""
        SELECT (SELECT count(*) FROM raw.events WHERE org_id = :o) AS raw_collected,
               count(*) FILTER (WHERE state IN ('pending', 'processing')) AS classifying,
               count(*) FILTER (WHERE state = 'clean') AS clean,
               count(*) FILTER (WHERE state = 'lowconf') AS lowconf,
               count(*) FILTER (WHERE state = 'discarded') AS discarded
        FROM refinery.event_state WHERE org_id = :o"""), {"o": row.org_id})).one()
    run = (await db.execute(text("""SELECT id, trigger, status, started_at, finished_at, input_count, clean_count,
                                           lowconf_count, noise_count, error_count
                                    FROM refinery.runs WHERE org_id = :o ORDER BY started_at DESC LIMIT 1"""),
                            {"o": row.org_id})).one_or_none()
    return {"raw_collected": c.raw_collected, "classifying": c.classifying, "clean": c.clean,
            "lowconf": c.lowconf, "discarded": c.discarded,
            "run": None if run is None else {
                "id": str(run.id), "trigger": run.trigger, "status": run.status,
                "started_at": run.started_at.isoformat() if run.started_at else None,
                "finished_at": run.finished_at.isoformat() if run.finished_at else None,
                "input_count": run.input_count, "clean_count": run.clean_count,
                "lowconf_count": run.lowconf_count, "noise_count": run.noise_count,
                "error_count": run.error_count}}


@router.put("/steps/12")
async def step12(request: Request, db: AsyncSession = DB,
                 user: service.CurrentUser | None = Depends(optional_user)) -> dict[str, Any]:
    """Hoàn tất: chỉ khi mọi bước bắt buộc đã xong. Bước chưa có ở giai đoạn này → báo rõ bước nào còn thiếu."""
    row, owner = await _owner_step(db, user)
    done = (row.completed or {}).get("steps", {})
    missing = [n for n, _k, _t, required, _p in STEPS if required and n != 12 and done.get(str(n)) != "done"]
    if missing:
        raise incomplete("Còn bước bắt buộc chưa xong: " + ", ".join(str(n) for n in missing))
    await db.execute(text("UPDATE ops.setup_state SET finished_at = now() WHERE org_id = :o"), {"o": row.org_id})
    return await _mark_done(db, request, await _row(db), owner, 12)
