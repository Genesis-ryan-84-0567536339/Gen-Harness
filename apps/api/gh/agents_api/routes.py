"""Danh tính Agent (PLAN 4.1) + phần còn thiếu của API & Model (PLAN 4.2, ARCHITECTURE §11).

Đã có sẵn từ giai đoạn 1/2 (KHÔNG viết lại ở đây): `/providers`, khoá (`/providers/{pid}/keys`, chỉ lộ `last4`),
model + hạn mức/giới hạn tốc độ hiển thị-chỉnh được (`/providers/{pid}/models`), kiểm kết nối (`/providers/{pid}/test`),
thẻ "Khoá & phiên" (`/providers/credentials`), hồ sơ Antigravity CLI (`gh.system_api.routes`); "agent đã nói gì,
nhân danh gì" (`agent.decisions`, `GET /agents/decisions` ở `gh.biz.core.routes` — tái dùng nguyên).

Module này thêm:
- CRUD `agent.identities` (tạo/sửa/liệt kê/nhân bản/tắt) + gắn phạm vi nghe `agent.channel_scopes`.
- Mẫu có sẵn (spec E13) — hardcode trong code, không phải bảng DB, chỉ là gợi ý khi tạo mới; không có mặc định
  bắt buộc (Bé Heo tắt sẵn, Owner phải tự bật).
- Gán model theo agent/mục đích + tham số core (`agent.bindings`: model, temperature, context_tokens, rule_codes).

Không thuộc `gh/biz/*` (không phải màn kinh doanh, không cần `ScopeFilter` theo người/nhóm) — quyền theo vai trò
thường `system.read` / `system.manage`, cùng cách `gh.plugins_api.routes` / `gh.system_api.routes` dùng.

Thứ tự route trong file: các đường literal (`/templates`, `/bindings`…) đặt TRƯỚC `/{agent_id}` — Starlette so
khớp theo thứ tự đăng ký, `/{agent_id}` (một đoạn biến) sẽ nuốt mọi đường một đoạn nếu đứng trước.
"""

import uuid
from typing import Any

import orjson
from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import rbac, service
from gh.auth.deps import require, require_pin
from gh.biz.duty.context import DEFAULT_CONTEXT_TOKENS
from gh.biz.duty.engine import DEFAULT_LIMITS
from gh.chassis import actionlog
from gh.chassis.policy import DEFAULT_AUTONOMY
from gh.data.common import iso
from gh.db import DB
from gh.errors import field_errors, not_found

router = APIRouter(prefix="/agents", tags=["agents"])
READ = require("system.read", rbac.ALL)
MANAGE = require("system.manage", rbac.ALL)

LIMIT_KEYS = set(DEFAULT_LIMITS)   # {"decisions_per_min", "drafts_per_hour"} — gh.biz.duty.engine.limits_of


# ─── mẫu có sẵn (spec E13 "Mẫu có sẵn (optional templates), không phải bản sắc hệ thống") ──────────────────────

TEMPLATES: dict[str, dict[str, Any]] = {
    "commercial": {
        "name": "Trợ lý thương mại",
        "role_desc": "Theo dõi cơ hội, nhắc việc quá hạn, soạn nháp trả lời khách hàng trong nhóm kinh doanh.",
        "voice": "Thân thiện, chuyên nghiệp, xưng hô lịch sự",
        "speak_when": "Khi được hỏi trực tiếp, có cơ hội mới, hoặc việc sắp quá hạn",
        "forbidden": ["Cam kết giá hoặc chiết khấu ngoài bảng giá đã duyệt", "Tự ý huỷ đơn hàng"],
        "default_enabled": True,
    },
    "key_account": {
        "name": "Key Account junior",
        "role_desc": "Hỗ trợ chăm sóc khách hàng lớn, theo dõi lời hứa và deal đang mở.",
        "voice": "Trang trọng, đúng hẹn, nhấn mạnh cam kết",
        "speak_when": "Khi khách VIP nhắn tin hoặc deal sắp tới hạn",
        "forbidden": ["Đàm phán giá cuối cùng thay Account Manager", "Hứa thời gian giao hàng chưa xác nhận với kho"],
        "default_enabled": True,
    },
    "admin": {
        "name": "Admin hậu cần",
        "role_desc": "Ghi nhận yêu cầu hậu cần, nhắc lịch, tổng hợp việc trong nhóm nội bộ.",
        "voice": "Gọn gàng, trung lập, đúng việc",
        "speak_when": "Khi có yêu cầu hậu cần mới hoặc việc tới hạn",
        "forbidden": ["Duyệt chi phí", "Thay đổi quyền truy cập hệ thống"],
        "default_enabled": True,
    },
    "cs": {
        "name": "CSKH",
        "role_desc": "Trả lời câu hỏi thường gặp, ghi nhận khiếu nại, theo dõi thời gian phản hồi khách hàng.",
        "voice": "Ấm áp, kiên nhẫn, xin lỗi đúng mực khi khách phàn nàn",
        "speak_when": "Khi khách hỏi hoặc phàn nàn trong nhóm/kênh chăm sóc",
        "forbidden": ["Hứa hoàn tiền hoặc đền bù", "Tiết lộ thông tin khách hàng khác"],
        "default_enabled": True,
    },
    "recruiter": {
        "name": "Recruiter",
        "role_desc": "Sàng lọc ứng viên, nhắc lịch phỏng vấn, tổng hợp hồ sơ.",
        "voice": "Chuyên nghiệp, tôn trọng ứng viên",
        "speak_when": "Khi có hồ sơ ứng viên mới hoặc lịch phỏng vấn sắp tới",
        "forbidden": ["Đưa ra kết quả tuyển dụng cuối cùng", "Nhận xét đánh giá cá nhân ứng viên"],
        "default_enabled": True,
    },
    "secretary": {
        "name": "Thư ký cá nhân",
        "role_desc": "Nhắc việc, tổng hợp tin nhắn quan trọng, quản lý lịch cho Owner.",
        "voice": "Riêng tư, ngắn gọn, đúng giờ",
        "speak_when": "Khi có việc cần nhắc hoặc tin nhắn quan trọng gửi tới Owner",
        "forbidden": ["Trả lời thay Owner trong các quyết định cá nhân", "Chia sẻ lịch trình ra ngoài nhóm riêng"],
        "default_enabled": True,
    },
    "mascot": {
        "name": "Bé Heo",
        "role_desc": "Mẫu hoài niệm từ heo-harness — trò chuyện phiếm, không đảm nhiệm việc kinh doanh.",
        "voice": "Dí dỏm, thân mật",
        "speak_when": "Chỉ khi được gọi trực tiếp",
        "forbidden": ["Tự ý tham gia nghiệp vụ kinh doanh", "Gửi tin ra ngoài khi chưa được bật"],
        "default_enabled": False,   # spec E13: "chỉ là template hoài niệm, tắt mặc định"
    },
}


@router.get("/templates")
async def list_templates(_: service.CurrentUser = Depends(READ)) -> list[dict[str, Any]]:
    return [{"code": k, **v} for k, v in TEMPLATES.items()]


def _check_template(v: str | None) -> str | None:
    if v is not None and v not in TEMPLATES:
        raise ValueError(f"Mẫu không tồn tại: {v}")
    return v


def _check_limits(v: dict[str, int]) -> dict[str, int]:
    for k, n in v.items():
        if k not in LIMIT_KEYS:
            raise ValueError(f"Khoá giới hạn không hợp lệ: {k} (chỉ nhận {', '.join(sorted(LIMIT_KEYS))})")
        if n <= 0:
            raise ValueError(f"{k} phải > 0")
    return v


# ─── gán model theo agent/mục đích (agent.bindings) ─────────────────────────────

# Mục đích dùng chung (ARCHITECTURE §11: "core agent suy luận chính, trả lời nhanh trong nhóm, tách ý định/phân
# loại, chấm điểm suy luận dài, đánh chỉ mục"). Ngoài ra mỗi agent identity có khoá riêng `agent:<id>`
# (gh.biz.duty.engine.agent_key) — danh sách động, ghép ở list_bindings(). Hiện tại chỉ `core.refinery`
# (gh.refinery.runner.AGENT_KEY) và `agent:<id>` thật sự được ModelRouter dùng khi gọi model; các mục còn lại là
# chỗ cấu hình trước cho lộ trình nối dây tiếp — không tự xưng đã nối dây đủ 5 mục đích.
CORE_AGENT_KEYS: dict[str, str] = {
    "core.refinery": "Sàng lọc & suy luận chính",
    "core.reply": "Trả lời nhanh trong nhóm",
    "core.intent": "Tách ý định / phân loại",
    "core.scoring": "Chấm điểm suy luận dài",
    "core.indexing": "Đánh chỉ mục / embedding",
}


async def _agent_key_label(db: AsyncSession, org_id: uuid.UUID, agent_key: str) -> str:
    if agent_key in CORE_AGENT_KEYS:
        return CORE_AGENT_KEYS[agent_key]
    if agent_key.startswith("agent:"):
        try:
            aid = uuid.UUID(agent_key[len("agent:"):])
        except ValueError as e:
            raise not_found("Agent") from e
        name = (await db.execute(text("SELECT name FROM agent.identities WHERE id = :i AND org_id = :o"),
                                 {"i": aid, "o": org_id})).scalar_one_or_none()
        if name is None:
            raise not_found("Agent")
        return str(name)
    raise field_errors({"agent_key": "agent_key phải là mục dùng chung (core.*) hoặc agent:<id>"})


def _binding_out(r: Any) -> dict[str, Any]:
    return {"model_id": str(r.model_id), "model_name": r.model_name, "provider_name": r.provider_name,
            "temperature": float(r.temperature), "context_tokens": r.context_tokens,
            "rule_codes": list(r.rule_codes or [])}


@router.get("/bindings")
async def list_bindings(user: service.CurrentUser = Depends(READ), db: AsyncSession = DB) -> dict[str, Any]:
    agents = (await db.execute(text("SELECT id, name FROM agent.identities WHERE org_id = :o ORDER BY created_at"),
                               {"o": user.org_id})).all()
    keys = [*CORE_AGENT_KEYS.items(), *((f"agent:{a.id}", a.name) for a in agents)]
    rows = (await db.execute(text("""
        SELECT b.agent_key, b.model_id, m.model_name, p.name AS provider_name, b.temperature, b.context_tokens,
               b.rule_codes
        FROM agent.bindings b JOIN agent.models m ON m.id = b.model_id JOIN agent.providers p ON p.id = m.provider_id
        WHERE b.org_id = :o"""), {"o": user.org_id})).all()
    by_key = {r.agent_key: r for r in rows}
    items = [{"agent_key": k, "label": label, "binding": _binding_out(by_key[k]) if k in by_key else None}
             for k, label in keys]
    models = (await db.execute(text("""
        SELECT m.id, m.model_name, p.name AS provider_name, m.is_enabled FROM agent.models m
        JOIN agent.providers p ON p.id = m.provider_id WHERE p.org_id = :o ORDER BY p.name, m.model_name"""),
        {"o": user.org_id})).all()
    return {"items": items,
            "models": [{"id": str(m.id), "model_name": m.model_name, "provider_name": m.provider_name,
                       "enabled": m.is_enabled} for m in models]}


class BindingIn(BaseModel):
    model_id: uuid.UUID
    temperature: float = Field(default=0.3, ge=0, le=2)
    context_tokens: int = Field(default=DEFAULT_CONTEXT_TOKENS, ge=256, le=200_000)
    rule_codes: list[str] = Field(default_factory=list, max_length=20)


@router.put("/bindings/{agent_key}")
async def set_binding(agent_key: str, body: BindingIn, user: service.CurrentUser = Depends(MANAGE),
                      db: AsyncSession = DB) -> dict[str, Any]:
    label = await _agent_key_label(db, user.org_id, agent_key)
    m = (await db.execute(text("""SELECT m.id FROM agent.models m JOIN agent.providers p ON p.id = m.provider_id
                                  WHERE m.id = :m AND p.org_id = :o"""),
                          {"m": body.model_id, "o": user.org_id})).one_or_none()
    if m is None:
        raise not_found("Model")
    await db.execute(text("""
        INSERT INTO agent.bindings (org_id, agent_key, model_id, temperature, context_tokens, rule_codes)
        VALUES (:o, :k, :m, :t, :ct, :rc)
        ON CONFLICT (org_id, agent_key) DO UPDATE
          SET model_id = :m, temperature = :t, context_tokens = :ct, rule_codes = :rc"""),
        {"o": user.org_id, "k": agent_key, "m": body.model_id, "t": body.temperature, "ct": body.context_tokens,
         "rc": body.rule_codes})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id, action="agent.bound",
                           target_type="binding", target_id=agent_key, target_label=label,
                           detail=body.model_dump(mode="json"), ip=user.ip)
    r = (await db.execute(text("""
        SELECT b.model_id, m.model_name, p.name AS provider_name, b.temperature, b.context_tokens, b.rule_codes
        FROM agent.bindings b JOIN agent.models m ON m.id = b.model_id JOIN agent.providers p ON p.id = m.provider_id
        WHERE b.org_id = :o AND b.agent_key = :k"""), {"o": user.org_id, "k": agent_key})).one()
    return {"agent_key": agent_key, "label": label, "binding": _binding_out(r)}


@router.delete("/bindings/{agent_key}", status_code=204)
async def delete_binding(agent_key: str, user: service.CurrentUser = Depends(MANAGE),
                         db: AsyncSession = DB) -> Response:
    row = (await db.execute(text("DELETE FROM agent.bindings WHERE org_id = :o AND agent_key = :k "
                                 "RETURNING agent_key"), {"o": user.org_id, "k": agent_key})).one_or_none()
    if row is None:
        raise not_found("Gán model")
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id, action="agent.unbound",
                           target_type="binding", target_id=agent_key, ip=user.ip)
    return Response(status_code=204)


# ─── danh tính agent (CRUD, phạm vi nghe) ────────────────────────────────────────

AGENT_SELECT = """
SELECT id, org_id, name, role_desc, template, addressing, voice, speak_when, forbidden, autonomy_level,
       is_enabled, limits, created_at, updated_at
FROM agent.identities
"""


class ScopeIn(BaseModel):
    channel_id: uuid.UUID
    group_id: uuid.UUID | None = None   # NULL = cả kênh (mọi nhóm đang nghe + tin 1-1)


class AgentIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    role_desc: str = Field(min_length=1, max_length=500)
    voice: str = Field(min_length=1, max_length=200)
    speak_when: str = Field(min_length=1, max_length=500)
    template: str | None = Field(default=None, max_length=40)
    addressing: dict[str, Any] = Field(default_factory=dict)
    forbidden: list[str] = Field(default_factory=list, max_length=50)
    autonomy_level: int = Field(default=DEFAULT_AUTONOMY, ge=0, le=6)
    limits: dict[str, int] = Field(default_factory=dict)
    is_enabled: bool = True
    channel_scopes: list[ScopeIn] = Field(default_factory=list, max_length=100)

    _v_template = field_validator("template")(_check_template)
    _v_limits = field_validator("limits")(_check_limits)


class AgentPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    role_desc: str | None = Field(default=None, min_length=1, max_length=500)
    voice: str | None = Field(default=None, min_length=1, max_length=200)
    speak_when: str | None = Field(default=None, min_length=1, max_length=500)
    template: str | None = Field(default=None, max_length=40)
    addressing: dict[str, Any] | None = None
    forbidden: list[str] | None = Field(default=None, max_length=50)
    autonomy_level: int | None = Field(default=None, ge=0, le=6)
    limits: dict[str, int] | None = None
    channel_scopes: list[ScopeIn] | None = None   # None = giữ nguyên phạm vi hiện có, [] = xoá hết

    _v_template = field_validator("template")(_check_template)

    @field_validator("limits")
    @classmethod
    def _v_limits(cls, v: dict[str, int] | None) -> dict[str, int] | None:
        return _check_limits(v) if v is not None else v


class CloneIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    copy_channel_scopes: bool = True


class DisableIn(BaseModel):
    enabled: bool = False


async def _validate_scopes(db: AsyncSession, org_id: uuid.UUID, scopes: list[ScopeIn]) -> None:
    if not scopes:
        return
    chan_ids = {s.channel_id for s in scopes}
    found = set((await db.execute(text("SELECT id FROM core.channels WHERE org_id = :o AND id = ANY(CAST(:ids AS "
                                       "uuid[]))"), {"o": org_id, "ids": [str(c) for c in chan_ids]})
                ).scalars().all())
    missing = chan_ids - found
    if missing:
        raise field_errors({"channel_scopes": f"Kênh không tồn tại: {', '.join(str(m) for m in missing)}"})
    group_ids = {s.group_id for s in scopes if s.group_id is not None}
    if group_ids:
        found_g = set((await db.execute(text("SELECT id FROM core.groups WHERE org_id = :o AND id = ANY(CAST(:ids "
                                              "AS uuid[]))"), {"o": org_id, "ids": [str(g) for g in group_ids]})
                      ).scalars().all())
        missing_g = group_ids - found_g
        if missing_g:
            raise field_errors({"channel_scopes": f"Nhóm không tồn tại: {', '.join(str(m) for m in missing_g)}"})


async def _replace_scopes(db: AsyncSession, agent_id: uuid.UUID, scopes: list[ScopeIn]) -> None:
    await db.execute(text("DELETE FROM agent.channel_scopes WHERE agent_id = :a"), {"a": agent_id})
    for s in scopes:
        await db.execute(text("""INSERT INTO agent.channel_scopes (agent_id, channel_id, group_id)
                                 VALUES (:a, :c, :g) ON CONFLICT DO NOTHING"""),
                         {"a": agent_id, "c": s.channel_id, "g": s.group_id})


async def _scopes_of(db: AsyncSession, agent_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = (await db.execute(text("""
        SELECT s.channel_id, c.type AS channel_type, s.group_id, g.name AS group_name
        FROM agent.channel_scopes s JOIN core.channels c ON c.id = s.channel_id
        LEFT JOIN core.groups g ON g.id = s.group_id
        WHERE s.agent_id = :a ORDER BY c.type, g.name NULLS FIRST"""), {"a": agent_id})).all()
    return [{"channel_id": str(r.channel_id), "channel_type": r.channel_type,
             "group_id": str(r.group_id) if r.group_id else None, "group_name": r.group_name} for r in rows]


async def _binding_of(db: AsyncSession, org_id: uuid.UUID, agent_id: uuid.UUID) -> dict[str, Any] | None:
    r = (await db.execute(text("""
        SELECT b.model_id, m.model_name, p.name AS provider_name, b.temperature, b.context_tokens, b.rule_codes
        FROM agent.bindings b JOIN agent.models m ON m.id = b.model_id JOIN agent.providers p ON p.id = m.provider_id
        WHERE b.org_id = :o AND b.agent_key = :k"""), {"o": org_id, "k": f"agent:{agent_id}"})).one_or_none()
    return None if r is None else _binding_out(r)


def _agent_out(r: Any) -> dict[str, Any]:
    return {"id": str(r.id), "name": r.name, "role_desc": r.role_desc, "template": r.template,
            "addressing": r.addressing or {}, "voice": r.voice, "speak_when": r.speak_when,
            "forbidden": list(r.forbidden or []), "autonomy_level": r.autonomy_level, "is_enabled": r.is_enabled,
            "limits": {**DEFAULT_LIMITS, **(r.limits or {})}, "created_at": iso(r.created_at),
            "updated_at": iso(r.updated_at)}


async def _full(db: AsyncSession, org_id: uuid.UUID, agent_id: uuid.UUID) -> dict[str, Any]:
    r = (await db.execute(text(AGENT_SELECT + " WHERE id = :i AND org_id = :o"),
                          {"i": agent_id, "o": org_id})).one_or_none()
    if r is None:
        raise not_found("Agent")
    out = _agent_out(r)
    out["channel_scopes"] = await _scopes_of(db, agent_id)
    out["binding"] = await _binding_of(db, org_id, agent_id)
    return out


@router.get("")
async def list_agents(user: service.CurrentUser = Depends(READ), db: AsyncSession = DB) -> list[dict[str, Any]]:
    rows = (await db.execute(text(AGENT_SELECT + " WHERE org_id = :o ORDER BY created_at"),
                             {"o": user.org_id})).all()
    out = []
    for r in rows:
        item = _agent_out(r)
        item["channel_scopes"] = await _scopes_of(db, r.id)
        item["binding"] = await _binding_of(db, user.org_id, r.id)
        out.append(item)
    return out


@router.post("", status_code=201)
async def create_agent(body: AgentIn, user: service.CurrentUser = Depends(MANAGE),
                       _pin: Any = Depends(require_pin("agent.manage")), db: AsyncSession = DB) -> dict[str, Any]:
    """Không có mặc định bắt buộc (spec E13) — Owner tự đặt mọi trường, mẫu chỉ là gợi ý prefill ở Console
    (`GET /agents/templates`), không tự áp khi thiếu. PIN vì đây là thao tác "tạo agent"."""
    await _validate_scopes(db, user.org_id, body.channel_scopes)
    aid = (await db.execute(text("""
        INSERT INTO agent.identities (org_id, name, role_desc, template, addressing, voice, speak_when, forbidden,
                                      autonomy_level, is_enabled, limits)
        VALUES (:o, :n, :rd, :tpl, CAST(:addr AS jsonb), :v, :sw, :fb, :al, :en, CAST(:lim AS jsonb))
        RETURNING id"""),
        {"o": user.org_id, "n": body.name.strip(), "rd": body.role_desc.strip(), "tpl": body.template,
         "addr": orjson.dumps(body.addressing).decode(), "v": body.voice.strip(), "sw": body.speak_when.strip(),
         "fb": body.forbidden, "al": body.autonomy_level, "en": body.is_enabled,
         "lim": orjson.dumps(body.limits).decode()})).scalar_one()
    await _replace_scopes(db, aid, body.channel_scopes)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id, action="agent.created",
                           target_type="agent", target_id=str(aid), target_label=body.name,
                           detail={"template": body.template, "autonomy_level": body.autonomy_level,
                                   "is_enabled": body.is_enabled, "scopes": len(body.channel_scopes)}, ip=user.ip)
    return await _full(db, user.org_id, aid)


@router.get("/{agent_id}")
async def get_agent(agent_id: uuid.UUID, user: service.CurrentUser = Depends(READ),
                    db: AsyncSession = DB) -> dict[str, Any]:
    return await _full(db, user.org_id, agent_id)


_PATCH_COLS = ("name", "role_desc", "voice", "speak_when", "template", "autonomy_level", "addressing", "forbidden",
              "limits")


@router.patch("/{agent_id}")
async def patch_agent(agent_id: uuid.UUID, body: AgentPatch, user: service.CurrentUser = Depends(MANAGE),
                      db: AsyncSession = DB) -> dict[str, Any]:
    cur = (await db.execute(text(AGENT_SELECT + " WHERE id = :i AND org_id = :o"),
                            {"i": agent_id, "o": user.org_id})).one_or_none()
    if cur is None:
        raise not_found("Agent")
    if body.channel_scopes is not None:
        await _validate_scopes(db, user.org_id, body.channel_scopes)
    fields = body.model_dump(exclude_unset=True, exclude={"channel_scopes"})
    changes: dict[str, Any] = {}
    for k in _PATCH_COLS:
        if k not in fields or fields[k] is None:
            continue
        v = fields[k]
        cur_v = getattr(cur, k)
        if k == "forbidden":
            cur_v = list(cur_v or [])
        elif k in ("addressing", "limits"):
            cur_v = cur_v or {}
        if v != cur_v:
            changes[k] = v
    if changes:
        sets: list[str] = []
        params: dict[str, Any] = {"i": agent_id}
        for k, v in changes.items():
            if k in ("addressing", "limits"):
                sets.append(f"{k} = CAST(:{k} AS jsonb)")
                params[k] = orjson.dumps(v).decode()
            else:
                sets.append(f"{k} = :{k}")
                params[k] = v.strip() if isinstance(v, str) else v
        sets.append("updated_at = now()")
        await db.execute(text(f"UPDATE agent.identities SET {', '.join(sets)} WHERE id = :i"), params)  # noqa: S608
    scope_changed = False
    if body.channel_scopes is not None:
        await _replace_scopes(db, agent_id, body.channel_scopes)
        scope_changed = True
    if changes or scope_changed:
        detail: dict[str, Any] = {"changed": list(changes)}
        if scope_changed:
            detail["channel_scopes"] = len(body.channel_scopes or [])
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="agent.updated", target_type="agent", target_id=str(agent_id),
                               target_label=cur.name, detail=detail, ip=user.ip)
    return await _full(db, user.org_id, agent_id)


@router.post("/{agent_id}/clone", status_code=201)
async def clone_agent(agent_id: uuid.UUID, body: CloneIn, user: service.CurrentUser = Depends(MANAGE),
                      _pin: Any = Depends(require_pin("agent.manage")), db: AsyncSession = DB) -> dict[str, Any]:
    """Nhân bản: sao mọi trường (kể cả phạm vi nghe nếu chọn) từ agent nguồn, NHƯNG tạo ở trạng thái tắt
    (`is_enabled=false`) — tránh hai agent cùng nghe/trả lời trùng nhau trước khi Owner rà lại bản sao. Quyết
    định tự đưa ra (PLAN không nói rõ trạng thái ban đầu của bản nhân bản)."""
    src = (await db.execute(text(AGENT_SELECT + " WHERE id = :i AND org_id = :o"),
                            {"i": agent_id, "o": user.org_id})).one_or_none()
    if src is None:
        raise not_found("Agent")
    new_id = (await db.execute(text("""
        INSERT INTO agent.identities (org_id, name, role_desc, template, addressing, voice, speak_when, forbidden,
                                      autonomy_level, is_enabled, limits)
        VALUES (:o, :n, :rd, :tpl, CAST(:addr AS jsonb), :v, :sw, :fb, :al, false, CAST(:lim AS jsonb))
        RETURNING id"""),
        {"o": user.org_id, "n": body.name.strip(), "rd": src.role_desc, "tpl": src.template,
         "addr": orjson.dumps(src.addressing or {}).decode(), "v": src.voice, "sw": src.speak_when,
         "fb": list(src.forbidden or []), "al": src.autonomy_level,
         "lim": orjson.dumps(src.limits or {}).decode()})).scalar_one()
    if body.copy_channel_scopes:
        await db.execute(text("""INSERT INTO agent.channel_scopes (agent_id, channel_id, group_id)
                                 SELECT :n, channel_id, group_id FROM agent.channel_scopes WHERE agent_id = :s"""),
                         {"n": new_id, "s": agent_id})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id, action="agent.cloned",
                           target_type="agent", target_id=str(new_id), target_label=body.name,
                           detail={"source_id": str(agent_id), "source_name": src.name,
                                   "copy_channel_scopes": body.copy_channel_scopes}, ip=user.ip)
    return await _full(db, user.org_id, new_id)


@router.patch("/{agent_id}/disable")
async def disable_agent(agent_id: uuid.UUID, body: DisableIn, user: service.CurrentUser = Depends(MANAGE),
                        _pin: Any = Depends(require_pin("agent.manage")), db: AsyncSession = DB) -> dict[str, Any]:
    """Tắt/bật một danh tính agent (cùng dạng toggle với `gh.plugins_api.routes.toggle`). Tắt KHÔNG xoá cấu hình
    hay phạm vi nghe — chỉ dừng agent nhận đơn vị mới (`agent.identities a JOIN ... WHERE a.is_enabled` ở
    `gh.biz.duty.context`)."""
    row = (await db.execute(text("""UPDATE agent.identities SET is_enabled = :e, updated_at = now()
                                    WHERE id = :i AND org_id = :o RETURNING name, is_enabled"""),
                            {"e": body.enabled, "i": agent_id, "o": user.org_id})).one_or_none()
    if row is None:
        raise not_found("Agent")
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="agent.enabled" if body.enabled else "agent.disabled", target_type="agent",
                           target_id=str(agent_id), target_label=row.name, ip=user.ip)
    return await _full(db, user.org_id, agent_id)


__all__ = ["router", "TEMPLATES", "CORE_AGENT_KEYS"]
