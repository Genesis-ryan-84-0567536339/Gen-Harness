"""/setup — trình thiết lập Owner 12 bước (docs/handoff/06). Giai đoạn 1 làm thật bước 1–3."""

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
from gh.db import get_db
from gh.errors import ApiError, conflict, field_errors, forbidden, unauthenticated

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
CURRENT_PHASE = 1
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
async def get_state(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    return state_payload(await _row(db))


@router.put("/steps/1")
async def step1(body: Step1In, request: Request, db: AsyncSession = Depends(get_db),
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
                db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
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
async def step3(body: Step3In, request: Request, db: AsyncSession = Depends(get_db),
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
async def skip(n: int, request: Request, db: AsyncSession = Depends(get_db),
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
