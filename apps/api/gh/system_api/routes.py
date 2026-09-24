"""Điều khiển hệ thống › Kênh & đăng nhập; nhà cung cấp model, khoá; hồ sơ Antigravity CLI (docs/api/phase-2.md)."""

import csv
import io
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

import orjson
from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh import crypto, realtime
from gh.audit.routes import export_rows, query_log
from gh.auth import rbac, service
from gh.auth.deps import require, require_pin
from gh.chassis import actionlog
from gh.chassis.bus import BRIDGE_CONTROL
from gh.data.common import CHANNEL_NAME, LISTENING_MODES, iso, org_settings
from gh.data.ingest import sync_listen_sets, uptime_pct
from gh.db import DB
from gh.errors import ApiError, conflict, field_errors, not_found
from gh.providers import cli as climod
from gh.providers.router import KEY_AAD, cooldown_key, quota_key
from gh.shell.routes import publish_header

router = APIRouter(tags=["system"])
READ = require("system.read")
MANAGE = require("system.manage")
ROLES_MANAGE = require("roles.manage")
AUDIT_READ = require("audit.read")
DATA_MANAGE = require("data.manage")

CHANNEL_TYPES = ("zalo", "whatsapp", "telegram", "linkedin")
QR_CHANNELS = ("zalo", "whatsapp")
LISTEN_MODES = ("off", "tagged_only", "silent", "proactive", "paused")
VIEW_SCOPES = ("owner", "manager", "all_members")
GROUP_KINDS = ("internal", "market", "partner", "customer", "private")


# ─── Kênh ───────────────────────────────────────────────────────────────────

async def _latest_session(db: AsyncSession, channel_id: uuid.UUID) -> Any:
    return (await db.execute(text("""
        SELECT id, state, account_label, started_at, ended_at, last_heartbeat_at, meta, qr_issued_at
        FROM core.channel_sessions WHERE channel_id = :c
        ORDER BY (ended_at IS NULL) DESC, COALESCE(started_at, qr_issued_at) DESC NULLS LAST, id DESC LIMIT 1"""),
        {"c": channel_id})).one_or_none()


async def channel_card(db: AsyncSession, redis: Any, org_id: uuid.UUID, type_: str) -> dict[str, Any]:
    ch = (await db.execute(text("SELECT id, name, capabilities FROM core.channels WHERE org_id = :o AND type = :t"),
                           {"o": org_id, "t": type_})).one_or_none()
    base: dict[str, Any] = {"type": type_, "name": CHANNEL_NAME[type_], "installed": ch is not None,
                            "id": str(ch.id) if ch else None, "account_label": None, "started_at": None,
                            "groups_listening": 0, "outbound_queued": 0, "last_heartbeat_at": None, "qr": None,
                            "stats": {"msgs_24h": None, "tagged_24h": None, "latency_ms": None, "uptime_pct": None}}
    if ch is None:
        return {**base, "state": "not_installed"}
    if "identity_only" in (ch.capabilities or []):
        n = (await db.execute(text("""
            SELECT count(*) AS ids,
                   count(*) FILTER (WHERE (SELECT count(*) FROM core.person_identities j
                                           WHERE j.person_id = i.person_id) > 1) AS merged
            FROM core.person_identities i WHERE i.channel_id = :c"""), {"c": ch.id})).one()
        return {**base, "state": "identity_only", "stats": {**base["stats"], "identities": n.ids, "merged": n.merged}}
    s = await _latest_session(db, ch.id)
    counts = (await db.execute(text("""
        SELECT count(*) AS msgs, count(*) FILTER (WHERE mentions_agent) AS tagged FROM raw.events
        WHERE channel_id = :c AND received_at > now() - interval '24 hours'"""), {"c": ch.id})).one()
    listening = (await db.execute(text("""SELECT count(*) FROM core.groups WHERE channel_id = :c
                                          AND listen_mode = ANY(:m)"""),
                                  {"c": ch.id, "m": list(LISTENING_MODES)})).scalar_one()
    state = s.state if s is not None else "logged_out"
    meta = (s.meta or {}) if s is not None else {}
    qr = None
    if s is not None and state == "pending_qr":
        raw = await redis.get(f"gh:channel:qr:{s.id}")
        if raw:
            q = orjson.loads(raw)
            qr = {"session_id": str(s.id), "image": q.get("image"), "expires_at": q.get("expires_at"),
                  "scanned": bool(q.get("scanned"))}
    return {**base, "state": state, "session_id": str(s.id) if s else None,
            "account_label": s.account_label if s else None, "started_at": iso(s.started_at) if s else None,
            "ended_at": iso(s.ended_at) if s else None, "groups_listening": listening,
            "outbound_queued": int(meta.get("queued") or 0),
            "last_heartbeat_at": iso(s.last_heartbeat_at) if s else None, "qr": qr, "error": meta.get("error"),
            "listen_direct": bool((await org_settings(db, org_id)).get("listen_direct", {}).get(type_, False)),
            "stats": {"msgs_24h": counts.msgs, "tagged_24h": counts.tagged, "latency_ms": meta.get("latency_ms"),
                      "uptime_pct": await uptime_pct(redis, type_, s.started_at)
                      if s is not None and state == "active" else None}}


@router.get("/channels")
async def channels(request: Request, user: service.CurrentUser = Depends(READ),
                   db: AsyncSession = DB) -> list[dict[str, Any]]:
    return [await channel_card(db, request.app.state.redis, user.org_id, t) for t in CHANNEL_TYPES]


class LoginIn(BaseModel):
    account_label: str | None = Field(default=None, max_length=80)
    accept_risk: bool = False


async def _qr_channel(db: AsyncSession, org_id: uuid.UUID, type_: str) -> Any:
    if type_ not in QR_CHANNELS:
        raise not_found("Kênh")
    ch = (await db.execute(text("SELECT id FROM core.channels WHERE org_id = :o AND type = :t"),
                           {"o": org_id, "t": type_})).one_or_none()
    if ch is None:
        raise not_found("Kênh")
    return ch


@router.post("/channels/{type_}/login", status_code=202)
async def channel_login(type_: str, body: LoginIn, request: Request, user: service.CurrentUser = Depends(MANAGE),
                        _pin: Any = Depends(require_pin("channel.login")),
                        db: AsyncSession = DB) -> dict[str, Any]:
    ch = await _qr_channel(db, user.org_id, type_)
    if not body.accept_risk:
        raise field_errors({"accept_risk": "Cần xác nhận đã đọc cảnh báo rủi ro tài khoản cá nhân"})
    redis = request.app.state.redis
    if not await redis.get("gh:bridge:heartbeat"):
        raise ApiError(503, "BRIDGE_OFFLINE", "Bridge kênh chưa chạy — kiểm tra dịch vụ bridge rồi thử lại")
    # Phiên đang chờ QR cũ bị huỷ; phiên đang hoạt động giữ tới khi phiên mới thành công.
    await db.execute(text("""UPDATE core.channel_sessions SET state = 'expired', ended_at = now()
                             WHERE channel_id = :c AND state = 'pending_qr' AND ended_at IS NULL"""), {"c": ch.id})
    sid = (await db.execute(text("""
        INSERT INTO core.channel_sessions (channel_id, org_id, account_label, state, qr_issued_at, risk_accepted_by)
        VALUES (:c, :o, :l, 'pending_qr', now(), :u) RETURNING id"""),
        {"c": ch.id, "o": user.org_id, "l": body.account_label or "", "u": user.id})).scalar_one()
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id, action="channel.login",
                           target_type="channel", target_id=type_, target_label=body.account_label,
                           detail={"session_id": str(sid), "accept_risk": True}, ip=user.ip)
    await db.commit()
    await request.app.state.bus.publish(BRIDGE_CONTROL, "session.login",
                                        {"channel": type_, "session_id": str(sid), "credential": None},
                                        actor=user.actor_id, org_id=user.org_id)
    await realtime.publish(redis, "channel.status", {"type": type_, "state": "pending_qr", "session_id": str(sid),
                                                     "account_label": body.account_label, "scanned": False,
                                                     "error": None}, org_id=user.org_id)
    return {"session_id": str(sid)}


@router.post("/channels/{type_}/logout", status_code=204)
async def channel_logout(type_: str, request: Request, user: service.CurrentUser = Depends(MANAGE),
                         _pin: Any = Depends(require_pin("channel.logout")),
                         db: AsyncSession = DB) -> Response:
    ch = await _qr_channel(db, user.org_id, type_)
    rows = (await db.execute(text("""
        UPDATE core.channel_sessions SET state = 'logged_out', ended_at = now(), credential_enc = NULL
        WHERE channel_id = :c AND ended_at IS NULL RETURNING id, account_label"""), {"c": ch.id})).all()
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id, action="channel.logout",
                           target_type="channel", target_id=type_,
                           target_label=rows[0].account_label if rows else None,
                           detail={"sessions": [str(r.id) for r in rows]}, ip=user.ip)
    await db.commit()
    for r in rows:
        await request.app.state.bus.publish(BRIDGE_CONTROL, "session.logout",
                                            {"channel": type_, "session_id": str(r.id)}, actor=user.actor_id,
                                            org_id=user.org_id)
    await realtime.publish(request.app.state.redis, "channel.status",
                           {"type": type_, "state": "logged_out", "session_id": str(rows[0].id) if rows else None,
                            "account_label": rows[0].account_label if rows else None, "scanned": False,
                            "error": None}, org_id=user.org_id)
    return Response(status_code=204)


class ChannelPatch(BaseModel):
    listen_direct: bool


@router.patch("/channels/{type_}")
async def channel_patch(type_: str, body: ChannelPatch, request: Request, user: service.CurrentUser = Depends(MANAGE),
                        _pin: Any = Depends(require_pin("policy.change")),
                        db: AsyncSession = DB) -> dict[str, Any]:
    await _qr_channel(db, user.org_id, type_)
    await db.execute(text("""
        UPDATE core.organizations SET settings = jsonb_set(
          CASE WHEN settings ? 'listen_direct' THEN settings ELSE settings || '{"listen_direct": {}}' END,
          ARRAY['listen_direct', :t], to_jsonb(CAST(:v AS boolean))) WHERE id = :o"""),
        {"t": type_, "v": body.listen_direct, "o": user.org_id})
    await sync_listen_sets(db, request.app.state.redis, user.org_id)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="channel.listen_direct_changed", target_type="channel", target_id=type_,
                           detail={"listen_direct": body.listen_direct}, ip=user.ip)
    return await channel_card(db, request.app.state.redis, user.org_id, type_)


def _group_out(r: Any) -> dict[str, Any]:
    return {"id": str(r.id), "code": r.code, "name": r.name, "members": r.member_count, "kind": r.kind,
            "listen_mode": r.listen_mode, "view_scope": r.view_scope, "msgs_24h": r.msgs,
            "channel": r.channel_type}


GROUP_SELECT = """
SELECT g.id, g.code, g.name, g.member_count, g.kind, g.listen_mode, g.view_scope, c.type AS channel_type,
       (SELECT count(*) FROM raw.events e
         WHERE e.group_id = g.id AND e.received_at > now() - interval '24 hours') AS msgs
FROM core.groups g JOIN core.channels c ON c.id = g.channel_id
"""


@router.get("/channels/{type_}/groups")
async def channel_groups(type_: str, user: service.CurrentUser = Depends(READ),
                         db: AsyncSession = DB) -> list[dict[str, Any]]:
    rows = (await db.execute(text(GROUP_SELECT + " WHERE c.org_id = :o AND c.type = :t ORDER BY g.name"),
                             {"o": user.org_id, "t": type_})).all()
    return [_group_out(r) for r in rows]


class GroupPatch(BaseModel):
    listen_mode: Literal["off", "tagged_only", "silent", "proactive", "paused"] | None = None
    view_scope: Literal["owner", "manager", "all_members"] | None = None
    kind: Literal["internal", "market", "partner", "customer", "private"] | None = None


async def update_group(db: AsyncSession, redis: Any, user: service.CurrentUser, gid: uuid.UUID,
                       body: GroupPatch) -> dict[str, Any]:
    cur = (await db.execute(text(GROUP_SELECT + " WHERE g.id = :i AND g.org_id = :o"),
                            {"i": gid, "o": user.org_id})).one_or_none()
    if cur is None:
        raise not_found("Nhóm")
    changes = {k: v for k, v in body.model_dump().items() if v is not None and getattr(cur, k) != v}
    if changes:
        sets = ", ".join(f"{k} = :{k}" for k in changes)
        await db.execute(text(f"UPDATE core.groups SET {sets} WHERE id = :i"), {**changes, "i": gid})  # noqa: S608
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="group.updated", target_type="group", target_id=cur.code, target_label=cur.name,
                               detail={"from": {k: getattr(cur, k) for k in changes}, "to": changes}, ip=user.ip)
        if "listen_mode" in changes:
            await sync_listen_sets(db, redis, user.org_id)
            await publish_header(db, redis, user.org_id)
    r = (await db.execute(text(GROUP_SELECT + " WHERE g.id = :i"), {"i": gid})).one()
    return _group_out(r)


@router.patch("/groups/{gid}")
async def patch_group(gid: uuid.UUID, body: GroupPatch, request: Request, user: service.CurrentUser = Depends(MANAGE),
                      db: AsyncSession = DB) -> dict[str, Any]:
    return await update_group(db, request.app.state.redis, user, gid, body)


# ─── Nhà cung cấp & khoá ───────────────────────────────────────────────────

PROVIDER_KINDS = ("antigravity_cli", "gemini", "deepseek", "openai_compat")
KEY_PREFIX = {"gemini": "GEM", "deepseek": "DS", "openai_compat": "API"}


class ProviderIn(BaseModel):
    kind: Literal["antigravity_cli", "gemini", "deepseek", "openai_compat"]
    name: str = Field(min_length=1, max_length=80)
    endpoint: str | None = Field(default=None, max_length=300)
    keys: list[str] = Field(default_factory=list, max_length=20)
    models: list[str] = Field(default_factory=list, max_length=20)


class KeyIn(BaseModel):
    secret: str = Field(min_length=8, max_length=500)


class ProviderPatch(BaseModel):
    enabled: bool | None = None
    failover_rank: int | None = Field(default=None, ge=1, le=99)


class ModelIn(BaseModel):
    model_name: str = Field(min_length=1, max_length=120)
    daily_quota: int | None = Field(default=None, ge=1)
    rate_limit_per_min: int | None = Field(default=None, ge=1)


async def _add_key(db: AsyncSession, provider_id: uuid.UUID, kind: str, secret: str) -> None:
    n = (await db.execute(text("SELECT count(*) FROM agent.provider_keys WHERE provider_id = :p"),
                          {"p": provider_id})).scalar_one()
    label = f"{KEY_PREFIX.get(kind, 'KEY')}-KEY-{n + 1:02d}"
    await db.execute(text("""INSERT INTO agent.provider_keys (provider_id, label, secret_enc, last4, rotation_order)
                             VALUES (:p, :l, :s, :f, :r)"""),
                     {"p": provider_id, "l": label, "s": crypto.encrypt(secret.strip().encode(), KEY_AAD),
                      "f": secret.strip()[-4:], "r": n})


async def provider_payloads(db: AsyncSession, redis: Any, org_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = (await db.execute(text("""SELECT * FROM agent.providers WHERE org_id = :o
                                     ORDER BY failover_rank NULLS LAST, created_at"""), {"o": org_id})).all()
    out = []
    for p in rows:
        keys = (await db.execute(text("""SELECT id, label, last4, is_enabled FROM agent.provider_keys
                                         WHERE provider_id = :p ORDER BY rotation_order"""), {"p": p.id})).all()
        models = (await db.execute(text("""SELECT id, model_name, daily_quota, rate_limit_per_min, is_enabled
                                           FROM agent.models WHERE provider_id = :p ORDER BY id"""),
                                   {"p": p.id})).all()
        key_out = []
        for k in keys:
            ttl = await redis.ttl(cooldown_key(k.id))
            key_out.append({"id": str(k.id), "label": k.label, "last4": k.last4, "enabled": k.is_enabled,
                            "cooldown_until": iso(datetime.fromtimestamp(datetime.now(UTC).timestamp() + ttl, UTC))
                            if ttl and ttl > 0 else None, "quota_left_pct": None})
        model_out = []
        for m in models:
            used = int(await redis.get(quota_key(m.id)) or 0)
            model_out.append({"id": str(m.id), "model_name": m.model_name, "daily_quota": m.daily_quota,
                              "rate_limit_per_min": m.rate_limit_per_min, "enabled": m.is_enabled,
                              "used_today": used,
                              "left_pct": (round(max(0, 100 - used * 100 / m.daily_quota), 1)
                                           if m.daily_quota else None)})
        out.append({"id": str(p.id), "kind": p.kind, "name": p.name, "endpoint": p.endpoint,
                    "failover_rank": p.failover_rank, "enabled": p.is_enabled, "auth_state": p.auth_state,
                    "account_label": p.account_label, "last_test": p.last_test, "keys": key_out, "models": model_out})
    return out


async def _provider(db: AsyncSession, org_id: uuid.UUID, pid: uuid.UUID) -> Any:
    r = (await db.execute(text("SELECT * FROM agent.providers WHERE id = :i AND org_id = :o"),
                          {"i": pid, "o": org_id})).one_or_none()
    if r is None:
        raise not_found("Nhà cung cấp")
    return r


async def _one_provider(db: AsyncSession, redis: Any, org_id: uuid.UUID, pid: uuid.UUID) -> dict[str, Any]:
    return next(p for p in await provider_payloads(db, redis, org_id) if p["id"] == str(pid))


@router.get("/providers")
async def providers(request: Request, user: service.CurrentUser = Depends(READ),
                    db: AsyncSession = DB) -> list[dict[str, Any]]:
    return await provider_payloads(db, request.app.state.redis, user.org_id)


@router.post("/providers", status_code=201)
async def create_provider(body: ProviderIn, request: Request, user: service.CurrentUser = Depends(MANAGE),
                          db: AsyncSession = DB) -> dict[str, Any]:
    if body.kind == "openai_compat" and not body.endpoint:
        raise field_errors({"endpoint": "Cần endpoint cho API tương thích OpenAI"})
    if body.kind != "antigravity_cli" and not body.keys:
        raise field_errors({"keys": "Cần ít nhất một khoá API"})
    if body.kind == "antigravity_cli":
        pid = await climod.cli_provider_id(db, user.org_id)
        await db.execute(text("UPDATE agent.providers SET name = :n WHERE id = :i"), {"n": body.name, "i": pid})
    else:
        rank = (await db.execute(text("""SELECT COALESCE(max(failover_rank), 0) + 1 FROM agent.providers
                                         WHERE org_id = :o"""), {"o": user.org_id})).scalar_one()
        pid = (await db.execute(text("""INSERT INTO agent.providers (org_id, kind, name, endpoint, failover_rank)
                                        VALUES (:o, :k, :n, :e, :r) RETURNING id"""),
                                {"o": user.org_id, "k": body.kind, "n": body.name, "e": body.endpoint,
                                 "r": rank})).scalar_one()
        for k in body.keys:
            await _add_key(db, pid, body.kind, k)
    for m in body.models:
        await db.execute(text("""INSERT INTO agent.models (provider_id, model_name) VALUES (:p, :m)
                                 ON CONFLICT DO NOTHING"""), {"p": pid, "m": m.strip()})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="provider.created", target_type="provider", target_id=str(pid),
                           target_label=body.name, detail={"kind": body.kind, "keys": len(body.keys),
                                                           "models": body.models}, ip=user.ip)
    return await _one_provider(db, request.app.state.redis, user.org_id, pid)


class ChainIn(BaseModel):
    provider_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)


@router.patch("/providers/chain")
async def patch_chain(body: ChainIn, request: Request, user: service.CurrentUser = Depends(MANAGE),
                      db: AsyncSession = DB) -> list[dict[str, Any]]:
    """Kéo-thả sắp lại toàn bộ chuỗi chuyển hướng một lượt (thiết kế `[providers]`) — khác `PATCH /providers/{id}`
    vốn chỉ đổi một ô; ở đây backend chỉ nhận thứ tự mới và ghi lại `failover_rank` theo đúng thứ tự đó.

    ĐĂNG KÝ TRƯỚC `PATCH /providers/{pid}` bên dưới — nếu không, Starlette so khớp `/providers/chain` vào mẫu
    `/providers/{pid}` (nhánh có sẵn từ giai đoạn 1/2) và "chain" bị parse nhầm thành UUID (422)."""
    ids = list(dict.fromkeys(body.provider_ids))
    have = set((await db.execute(text("SELECT id FROM agent.providers WHERE org_id = :o"),
                                 {"o": user.org_id})).scalars().all())
    if set(ids) != have:
        raise field_errors({"provider_ids": "Cần đúng và đủ danh sách nhà cung cấp hiện có, không thiếu không thừa"})
    for rank, pid in enumerate(ids, start=1):
        await db.execute(text("UPDATE agent.providers SET failover_rank = :r WHERE id = :i"), {"r": rank, "i": pid})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="provider.chain_reordered", target_type="provider",
                           detail={"order": [str(i) for i in ids]}, ip=user.ip)
    return await provider_payloads(db, request.app.state.redis, user.org_id)


@router.patch("/providers/{pid}")
async def patch_provider(pid: uuid.UUID, body: ProviderPatch, request: Request,
                         user: service.CurrentUser = Depends(MANAGE), db: AsyncSession = DB
                         ) -> dict[str, Any]:
    p = await _provider(db, user.org_id, pid)
    if body.enabled is not None:
        await db.execute(text("UPDATE agent.providers SET is_enabled = :e WHERE id = :i"),
                         {"e": body.enabled, "i": pid})
    if body.failover_rank is not None and body.failover_rank != p.failover_rank:
        # Đổi chỗ trong chuỗi: đẩy các nhà cung cấp khác lùi một bậc.
        await db.execute(text("""UPDATE agent.providers SET failover_rank = failover_rank + 1
                                 WHERE org_id = :o AND id <> :i AND failover_rank >= :r"""),
                         {"o": user.org_id, "i": pid, "r": body.failover_rank})
        await db.execute(text("UPDATE agent.providers SET failover_rank = :r WHERE id = :i"),
                         {"r": body.failover_rank, "i": pid})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="provider.updated", target_type="provider", target_id=str(pid), target_label=p.name,
                           detail=body.model_dump(exclude_none=True), ip=user.ip)
    return await _one_provider(db, request.app.state.redis, user.org_id, pid)


@router.post("/providers/{pid}/keys", status_code=201)
async def add_key(pid: uuid.UUID, body: KeyIn, request: Request, user: service.CurrentUser = Depends(MANAGE),
                  db: AsyncSession = DB) -> dict[str, Any]:
    p = await _provider(db, user.org_id, pid)
    if p.kind == "antigravity_cli":
        raise conflict("CLI_NO_KEYS", "Antigravity CLI dùng phiên đăng nhập, không dùng khoá API")
    await _add_key(db, pid, p.kind, body.secret)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="provider.key_added",
                           target_type="provider", target_id=str(pid), target_label=p.name,
                           detail={"last4": body.secret.strip()[-4:]}, ip=user.ip)
    return await _one_provider(db, request.app.state.redis, user.org_id, pid)


@router.delete("/providers/{pid}/keys/{kid}", status_code=204)
async def delete_key(pid: uuid.UUID, kid: uuid.UUID, user: service.CurrentUser = Depends(MANAGE),
                     db: AsyncSession = DB) -> Response:
    p = await _provider(db, user.org_id, pid)
    row = (await db.execute(text("DELETE FROM agent.provider_keys WHERE id = :k AND provider_id = :p RETURNING label"),
                            {"k": kid, "p": pid})).one_or_none()
    if row is None:
        raise not_found("Khoá")
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="provider.key_deleted", target_type="provider", target_id=str(pid),
                           target_label=p.name, detail={"key": row.label}, ip=user.ip)
    return Response(status_code=204)


@router.post("/providers/{pid}/models", status_code=201)
async def add_model(pid: uuid.UUID, body: ModelIn, request: Request, user: service.CurrentUser = Depends(MANAGE),
                    db: AsyncSession = DB) -> dict[str, Any]:
    p = await _provider(db, user.org_id, pid)
    await db.execute(text("""
        INSERT INTO agent.models (provider_id, model_name, daily_quota, rate_limit_per_min) VALUES (:p, :m, :q, :r)
        ON CONFLICT (provider_id, model_name) DO UPDATE SET daily_quota = :q, rate_limit_per_min = :r"""),
        {"p": pid, "m": body.model_name.strip(), "q": body.daily_quota, "r": body.rate_limit_per_min})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="provider.model_set", target_type="provider", target_id=str(pid),
                           target_label=p.name, detail=body.model_dump(), ip=user.ip)
    return await _one_provider(db, request.app.state.redis, user.org_id, pid)


@router.post("/providers/{pid}/test")
async def test_provider(pid: uuid.UUID, request: Request, user: service.CurrentUser = Depends(MANAGE),
                        db: AsyncSession = DB) -> dict[str, Any]:
    p = await _provider(db, user.org_id, pid)
    await db.commit()
    result: dict[str, Any] = await request.app.state.model_router.test_provider(pid)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id, action="provider.tested",
                           target_type="provider", target_id=str(pid), target_label=p.name,
                           result="ok" if result["ok"] else "failed", detail={"error": result["error"]}, ip=user.ip)
    return result


@router.get("/providers/credentials")
async def credentials(request: Request, user: service.CurrentUser = Depends(READ),
                      db: AsyncSession = DB) -> list[dict[str, Any]]:
    """Dòng thẻ "Khoá & phiên" (thiết kế `creds`): khoá API theo nhà cung cấp + khoá phiên QR theo kênh."""
    out: list[dict[str, Any]] = []
    for p in await provider_payloads(db, request.app.state.redis, user.org_id):
        if p["kind"] == "antigravity_cli":
            state = {"ok": "ok", "expiring": "warn"}.get(p["auth_state"], "bad")
            out.append({"icon": "terminal-window", "name": f"{p['name']} — phiên CLI",
                        "meta": p["account_label"] or "chưa đăng nhập", "state": state,
                        "state_label": {"ok": "Hoạt động", "warn": "Sắp hết hạn"}.get(state, "Cần đăng nhập")})
            continue
        n = len(p["keys"])
        low = [m for m in p["models"] if m["left_pct"] is not None and m["left_pct"] < 20]
        cooling = [k for k in p["keys"] if k["cooldown_until"]]
        name = f"{p['name']} — {n} khoá xoay vòng" if n > 1 else p["name"]
        labels = " … ".join(dict.fromkeys([p["keys"][0]["label"], p["keys"][-1]["label"]])) if n else "chưa có khoá"
        meta = labels + (f" · còn {low[0]['left_pct']:.0f}% hạn mức".replace(".", ",") if low else "")
        state = "bad" if not n or len(cooling) == n or p["auth_state"] == "expired" else "warn" if low or cooling \
            else "ok"
        out.append({"icon": "key", "name": name, "meta": meta, "state": state,
                    "state_label": {"ok": "Hoạt động", "warn": "Sắp cạn" if low else "Đang nghỉ",
                                    "bad": "Không dùng được"}[state]})
    for t in QR_CHANNELS:
        card = await channel_card(db, request.app.state.redis, user.org_id, t)
        if card["state"] == "not_installed":
            continue
        ok = card["state"] == "active"
        meta = f"gắn thiết bị {card['account_label']}" if ok and card["account_label"] else (
            f"hết hạn {card['ended_at'][11:16]} UTC" if card.get("ended_at") else "chưa đăng nhập")
        out.append({"icon": "qr-code", "name": f"{card['name']} — khoá phiên QR", "meta": meta,
                    "state": "ok" if ok else "bad", "state_label": "Hoạt động" if ok else (
                        "Hết hạn" if card["state"] == "expired" else "Chưa đăng nhập")})
    return out


# ─── Antigravity CLI ───────────────────────────────────────────────────────

class CodeIn(BaseModel):
    code: str = Field(min_length=4, max_length=500)


@router.get("/cli/profiles")
async def cli_profiles(user: service.CurrentUser = Depends(READ),
                       db: AsyncSession = DB) -> list[dict[str, Any]]:
    return await climod.profiles(db, user.org_id)


@router.post("/cli/login", status_code=202)
async def cli_login(request: Request, user: service.CurrentUser = Depends(MANAGE),
                    db: AsyncSession = DB) -> dict[str, Any]:
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="cli.login_started", target_type="cli", ip=user.ip)
    await db.commit()
    s = await request.app.state.cli_logins.start(user.org_id, user.id)
    return {"login_id": s.id}


@router.post("/cli/login/{login_id}/code", status_code=202)
async def cli_code(login_id: str, body: CodeIn, request: Request,
                   user: service.CurrentUser = Depends(MANAGE)) -> dict[str, Any]:
    s = request.app.state.cli_logins.get(login_id, user.org_id)
    if s is None or s.status != "waiting_code":
        raise conflict("CLI_LOGIN_NOT_WAITING", "Phiên đăng nhập không ở bước chờ mã")
    await request.app.state.cli_logins.submit(s, body.code)
    return {}


@router.post("/cli/login/{login_id}/cancel", status_code=204)
async def cli_cancel(login_id: str, request: Request, user: service.CurrentUser = Depends(MANAGE)) -> Response:
    if request.app.state.cli_logins.get(login_id, user.org_id) is None:
        raise not_found("Phiên đăng nhập")
    request.app.state.cli_logins.cancel(login_id)
    return Response(status_code=204)


@router.post("/cli/profiles/{profile_id}/activate")
async def cli_activate(profile_id: uuid.UUID, user: service.CurrentUser = Depends(MANAGE),
                       _pin: Any = Depends(require_pin("cli.switch_account")),
                       db: AsyncSession = DB) -> dict[str, Any]:
    out = await climod.activate(db, user.org_id, profile_id)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="cli.account_switched", target_type="cli_profile", target_id=out["id"],
                           target_label=out["email"], ip=user.ip)
    return next(p for p in await climod.profiles(db, user.org_id) if p["id"] == out["id"])


@router.delete("/cli/profiles/{profile_id}", status_code=204)
async def cli_delete(profile_id: uuid.UUID, user: service.CurrentUser = Depends(MANAGE),
                     _pin: Any = Depends(require_pin("cli.switch_account")),
                     db: AsyncSession = DB) -> Response:
    out = await climod.delete_profile(db, user.org_id, profile_id)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="cli.profile_deleted", target_type="cli_profile", target_id=str(profile_id),
                           target_label=out["email"], detail={"was_active": out["was_active"]}, ip=user.ip)
    return Response(status_code=204)


# ─── Bộ não AI: chuỗi chuyển hướng + quy tắc ────────────────────────────────

# Quy tắc chuyển hướng (ARCHITECTURE §11, thiết kế `failoverRules`) — cố định trong `gh.providers.router`, không
# có tham số nào Owner chỉnh được ở đây nên chỉ có GET (đọc để hiển thị, không PATCH).
FAILOVER_RULES: tuple[dict[str, str], ...] = (
    {"key": "hết hạn mức", "value": "chuyển xuống nhà cung cấp kế tiếp trong chuỗi"},
    {"key": "ngắt mạch", "value": "giữ nguyên hội thoại, thử lại sau 60 giây"},
    {"key": "hết chuỗi", "value": "xếp hàng và báo Sếp qua hàng đợi cần xử lý"},
    {"key": "ngưỡng cảnh báo", "value": "còn dưới 20% hạn mức trên bất kỳ model nào"},
)


@router.get("/failover-rules")
async def failover_rules(user: service.CurrentUser = Depends(READ)) -> list[dict[str, str]]:
    return list(FAILOVER_RULES)


# ─── Quyền hạn: ma trận, nhóm lắng nghe, ranh giới ──────────────────────────

# 7 cột của ma trận thiết kế (`permCols`) → các quyền (`core.permissions`) thuộc cột đó. `data.*`/`system.*`/
# `roles.manage` nằm NGOÀI ma trận thiết kế (rbac.py) nên không sửa được qua đây — chỉ Owner có, không cấu hình.
PERMISSION_COLUMNS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("overview", "Tổng quan", ("overview.read",)),
    ("queue", "Hàng đợi", ("queue.read", "queue.act")),
    ("profile", "Hồ sơ khách", ("profile.read", "profile.write")),
    ("people_review", "Đánh giá nhân sự", ("people_review.read", "people_review.write", "care.read")),
    ("opportunity", "Cơ hội", ("opportunity.read", "opportunity.write")),
    ("action", "Hành động", ("action.draft", "action.approve")),
    ("audit", "Nhật ký", ("audit.read",)),
)
EDITABLE_PERMISSIONS = frozenset(c for _, _, codes in PERMISSION_COLUMNS for c in codes)


@router.get("/permissions")
async def get_permissions(user: service.CurrentUser = Depends(READ), db: AsyncSession = DB) -> dict[str, Any]:
    rows = (await db.execute(text("""
        SELECT r.code AS role_code, rp.permission_code, rp.scope FROM core.role_permissions rp
        JOIN core.roles r ON r.id = rp.role_id WHERE r.org_id = :o"""), {"o": user.org_id})).all()
    by_role: dict[str, dict[str, str]] = {}
    for r in rows:
        by_role.setdefault(r.role_code, {})[r.permission_code] = r.scope
    roles_out = [{"code": rd.code, "name": rd.name, "meta": rd.meta,
                 "permissions": {c: by_role.get(rd.code, {}).get(c, rbac.NONE) for c in EDITABLE_PERMISSIONS}}
                for rd in rbac.ROLES]
    return {"columns": [{"key": k, "label": lbl, "permissions": list(codes)} for k, lbl, codes in PERMISSION_COLUMNS],
            "roles": roles_out}


class PermissionPatch(BaseModel):
    role: Literal["owner", "manager", "operator", "agent_staff", "auditor"]
    permission: str = Field(max_length=60)
    scope: Literal["all", "team", "assigned", "none"]


@router.patch("/permissions")
async def patch_permissions(body: PermissionPatch, user: service.CurrentUser = Depends(ROLES_MANAGE),
                            _pin: Any = Depends(require_pin("roles.change")),
                            db: AsyncSession = DB) -> dict[str, Any]:
    """Owner sửa từng ô của ma trận (PIN + log, ARCHITECTURE §7.4/§8.3). Hai bất biến không sửa được qua API —
    `gh.bootstrap._permissions` đặt lại nếu có ai chỉnh thẳng DB, ở đây từ chối thẳng (422):
    Owner luôn `all` mọi cột; Auditor không bao giờ có quyền ghi (`rbac.WRITE_PERMISSIONS`)."""
    if body.permission not in EDITABLE_PERMISSIONS:
        raise field_errors({"permission": "Quyền này không nằm trong ma trận sửa được ở Quyền hạn"})
    if body.role == rbac.OWNER and body.scope != rbac.ALL:
        raise field_errors({"scope": "Owner luôn toàn quyền ở mọi cột — khoá cứng, không sửa được"})
    if body.role == rbac.AUDITOR and body.permission in rbac.WRITE_PERMISSIONS and body.scope != rbac.NONE:
        raise field_errors({"scope": "Auditor không bao giờ có quyền ghi — khoá cứng, không sửa được"})
    row = (await db.execute(text("""
        SELECT rp.scope, r.id AS role_id FROM core.role_permissions rp JOIN core.roles r ON r.id = rp.role_id
        WHERE r.org_id = :o AND r.code = :role AND rp.permission_code = :perm"""),
        {"o": user.org_id, "role": body.role, "perm": body.permission})).one_or_none()
    if row is None:
        raise not_found("Ô ma trận")
    await db.execute(text("""UPDATE core.role_permissions SET scope = :s
                             WHERE role_id = :rid AND permission_code = :perm"""),
                     {"s": body.scope, "rid": row.role_id, "perm": body.permission})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="permission.changed", target_type="role", target_id=body.role,
                           target_label=body.permission, detail={"permission": body.permission,
                                                                  "from": row.scope, "to": body.scope}, ip=user.ip)
    return await get_permissions(user, db)


@router.get("/listening-groups")
async def listening_groups(user: service.CurrentUser = Depends(READ), db: AsyncSession = DB) -> list[dict[str, Any]]:
    """Nhóm đang lắng nghe (khoá cứng #1 `listen_authorized_only` — chỉ nhóm Owner đã bật mới vào đây)."""
    rows = (await db.execute(text(GROUP_SELECT + " WHERE c.org_id = :o AND g.listen_mode <> 'off' ORDER BY g.name"),
                             {"o": user.org_id})).all()
    return [_group_out(r) for r in rows]


# Nhãn tiếng Việt cho `ops.policy_boundaries.code` (ARCHITECTURE §7.4 + PLAN Q "Mặc định giới hạn"); 6/8 khoá cứng
# có mặt ở đây dưới dạng `is_locked=true` — 2 khoá còn lại (#5 kho thô/nhật ký chỉ-INSERT, #6 PIN+mã hoá bí mật)
# là bất biến ở tầng DB/code, không phải công tắc nên không có dòng `ops.policy_boundaries` tương ứng.
BOUNDARY_LABELS: dict[str, str] = {
    "listen_authorized_only": "Chỉ lắng nghe nhóm Owner đã bật",
    "disclose_staff_observation": "Công khai nội bộ khi dùng để đánh giá nhân sự",
    "hide_sensitive_below_owner": "Ẩn dữ liệu nhạy cảm khỏi vai trò dưới Owner",
    "personnel_alert_requires_evidence": "Điểm số, cảnh báo nhân sự phải có chứng cứ",
    "observe_external_market": "Quan sát nhóm thị trường bên ngoài",
    "auto_personnel_decisions": "Hệ thống tự ra quyết định nhân sự",
    "approval_gate": "Gửi ra ngoài / vượt ngưỡng tiền / liên quan nhân sự luôn chờ duyệt",
    "mcp_write_requires_approval": "Tool MCP loại ghi qua duyệt trước khi chạy",
}


@router.get("/boundaries")
async def get_boundaries(user: service.CurrentUser = Depends(READ), db: AsyncSession = DB) -> list[dict[str, Any]]:
    rows = (await db.execute(text("""SELECT code, is_enabled, is_locked, params FROM ops.policy_boundaries
                                     WHERE org_id = :o ORDER BY code"""), {"o": user.org_id})).all()
    return [{"code": r.code, "label": BOUNDARY_LABELS.get(r.code, r.code), "enabled": r.is_enabled,
             "locked": r.is_locked, "params": r.params} for r in rows]


class BoundaryPatch(BaseModel):
    enabled: bool | None = None
    params: dict[str, Any] | None = None


@router.patch("/boundaries/{code}")
async def patch_boundary(code: str, body: BoundaryPatch, user: service.CurrentUser = Depends(MANAGE),
                         _pin: Any = Depends(require_pin("policy.change")), db: AsyncSession = DB
                         ) -> dict[str, Any]:
    """Ranh giới có trách nhiệm (PIN + log). Khoá cứng (`is_locked`) không tắt/bật được (422) dù có PIN đúng —
    `params` (ví dụ `approval_threshold_vnd`) sửa được ngay cả khi ranh giới đó bị khoá bật, vì bản thân việc
    CÓ chờ duyệt là bất biến, còn NGƯỠNG là do Owner đặt (ARCHITECTURE §7.2)."""
    row = (await db.execute(text("""SELECT is_enabled, is_locked, params FROM ops.policy_boundaries
                                    WHERE org_id = :o AND code = :c"""), {"o": user.org_id, "c": code})).one_or_none()
    if row is None:
        raise not_found("Ranh giới")
    if body.enabled is not None and body.enabled != row.is_enabled and row.is_locked:
        raise field_errors({"enabled": "Ranh giới này là khoá cứng — không tắt/bật được (ARCHITECTURE §7.4)"})
    if code == "approval_gate" and body.params and "approval_threshold_vnd" in body.params:
        v = body.params["approval_threshold_vnd"]
        if not isinstance(v, int) or isinstance(v, bool) or v < 0:
            raise field_errors({"params.approval_threshold_vnd": "Ngưỡng tiền phải là số nguyên không âm"})
    sets: list[str] = []
    params: dict[str, Any] = {"o": user.org_id, "c": code}
    if body.enabled is not None:
        sets.append("is_enabled = :e")
        params["e"] = body.enabled
    if body.params is not None:
        sets.append("params = params || CAST(:p AS jsonb)")
        params["p"] = orjson.dumps(body.params).decode()
    if sets:
        await db.execute(text(f"UPDATE ops.policy_boundaries SET {', '.join(sets)} WHERE org_id = :o AND code = :c"),
                         params)  # noqa: S608 — sets chỉ gồm hằng cố định ở trên
    new = (await db.execute(text("""SELECT is_enabled, is_locked, params FROM ops.policy_boundaries
                                    WHERE org_id = :o AND code = :c"""), {"o": user.org_id, "c": code})).one()
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="boundary.changed", target_type="boundary", target_id=code,
                           target_label=BOUNDARY_LABELS.get(code, code),
                           detail={"from": {"enabled": row.is_enabled, "params": row.params},
                                   "to": {"enabled": new.is_enabled, "params": new.params}}, ip=user.ip)
    return {"code": code, "label": BOUNDARY_LABELS.get(code, code), "enabled": new.is_enabled,
            "locked": new.is_locked, "params": new.params}


# ─── Nhật ký ─────────────────────────────────────────────────────────────────

@router.get("/audit-log")
async def system_audit_log(cursor: str | None = None, limit: int = Query(50, ge=1, le=200),
                           actor_type: str | None = None, action: str | None = None,
                           target_type: str | None = None, target_id: str | None = None,
                           since: datetime | None = None, until: datetime | None = None,
                           user: service.CurrentUser = Depends(AUDIT_READ), db: AsyncSession = DB
                           ) -> dict[str, Any]:
    """Cùng đường đọc với `/audit` (`gh.audit.routes.query_log`) — chỉ thêm chỗ vào tab Nhật ký của Điều khiển
    hệ thống, thêm lọc theo đối tượng/thời gian mà `[auditLog]` cần."""
    return await query_log(db, user, cursor=cursor, limit=limit, actor_type=actor_type, action=action,
                           target_type=target_type, target_id=target_id, since=since, until=until)


@router.get("/audit-log/export")
async def system_audit_log_export(actor_type: str | None = None, action: str | None = None,
                                  target_type: str | None = None, target_id: str | None = None,
                                  since: datetime | None = None, until: datetime | None = None,
                                  user: service.CurrentUser = Depends(DATA_MANAGE),
                                  _pin: Any = Depends(require_pin("data.export")), db: AsyncSession = DB
                                  ) -> Response:
    """Xuất CSV nhật ký — cùng khuôn với `POST /raw/export` (`gh.data_api.routes.raw_export`): quyền quản lý dữ
    liệu + PIN, ghi lại chính lượt xuất vào Action Log."""
    rows = await export_rows(db, user, actor_type=actor_type, action=action, target_type=target_type,
                             target_id=target_id, since=since, until=until)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["at", "actor_type", "actor_id", "actor_label", "action", "target_type", "target_id", "target_label",
                "autonomy_level", "result"])
    for it in rows:
        w.writerow([it["at"], it["actor_type"], it["actor_id"], it["actor_label"], it["action"], it["target_type"],
                    it["target_id"], it["target_label"], it["autonomy_level"], it["result"]])
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="audit_log.exported", target_type="audit_log",
                           detail={"rows": len(rows), "filters": {"actor_type": actor_type, "action": action,
                                                                  "target_type": target_type, "target_id": target_id}},
                           ip=user.ip)
    name = f"nhat-ky-{datetime.now(UTC):%Y%m%d-%H%M}.csv"
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"content-disposition": f'attachment; filename="{name}"'})


# ─── Dữ liệu & lưu trữ (spec I) ──────────────────────────────────────────────

# Tập dữ liệu Owner đặt được hạn lưu (`ops.retention_policies`, thiết kế 01-ui-screens §system bổ sung).
RETENTION_DATASETS = ("raw.events", "clean.meaning_units", "ops.action_log", "memory.entries", "agent.model_calls")


@router.get("/retention-policies")
async def get_retention(user: service.CurrentUser = Depends(READ), db: AsyncSession = DB) -> list[dict[str, Any]]:
    rows = (await db.execute(text("""SELECT dataset, keep_days, anonymize_after_days FROM ops.retention_policies
                                     WHERE org_id = :o"""), {"o": user.org_id})).all()
    by_ds = {r.dataset: r for r in rows}
    return [{"dataset": d, "keep_days": by_ds[d].keep_days if d in by_ds else None,
             "anonymize_after_days": by_ds[d].anonymize_after_days if d in by_ds else None}
            for d in RETENTION_DATASETS]


class RetentionIn(BaseModel):
    dataset: Literal["raw.events", "clean.meaning_units", "ops.action_log", "memory.entries", "agent.model_calls"]
    keep_days: int | None = Field(default=None, ge=1, le=3650)
    anonymize_after_days: int | None = Field(default=None, ge=1, le=3650)


@router.patch("/retention-policies")
async def patch_retention(body: RetentionIn, user: service.CurrentUser = Depends(MANAGE),
                          _pin: Any = Depends(require_pin("policy.change")), db: AsyncSession = DB
                          ) -> list[dict[str, Any]]:
    await db.execute(text("""
        INSERT INTO ops.retention_policies (org_id, dataset, keep_days, anonymize_after_days)
        VALUES (:o, :d, :k, :a)
        ON CONFLICT (org_id, dataset) DO UPDATE SET keep_days = :k, anonymize_after_days = :a"""),
        {"o": user.org_id, "d": body.dataset, "k": body.keep_days, "a": body.anonymize_after_days})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="retention_policy.changed", target_type="retention_policy",
                           target_id=body.dataset, detail=body.model_dump(), ip=user.ip)
    return await get_retention(user, db)


async def _person_row(db: AsyncSession, org_id: uuid.UUID, person_id: uuid.UUID) -> Any:
    r = (await db.execute(text("SELECT id, code, display_name, attrs FROM core.persons WHERE id = :i AND org_id = :o"),
                          {"i": person_id, "o": org_id})).one_or_none()
    if r is None:
        raise not_found("Người")
    return r


async def _export_person_bundle(db: AsyncSession, person: Any) -> dict[str, Any]:
    identities = (await db.execute(text("""
        SELECT c.type AS channel, ci.external_id, ci.handle, ci.phone_e164, ci.first_seen_at
        FROM core.person_identities ci JOIN core.channels c ON c.id = ci.channel_id
        WHERE ci.person_id = :p"""), {"p": person.id})).all()
    scores = (await db.execute(text("""SELECT dimension, value, trend, updated_at FROM clean.current_scores
                                       WHERE subject_type = 'person' AND subject_id = :p"""),
                               {"p": person.id})).all()
    notes = (await db.execute(text("""
        SELECT e.section, e.body, e.author, e.created_at FROM memory.entries e
        JOIN memory.notebooks n ON n.id = e.notebook_id
        WHERE n.subject_type = 'person' AND n.subject_id = :p AND e.archived_at IS NULL
        ORDER BY e.created_at"""), {"p": person.id})).all()
    return {"person": {"id": str(person.id), "code": person.code, "display_name": person.display_name,
                       "attrs": person.attrs},
            "identities": [{"channel": i.channel, "external_id": i.external_id, "handle": i.handle,
                            "phone_e164": i.phone_e164, "first_seen_at": iso(i.first_seen_at)} for i in identities],
            "scores": [{"dimension": s.dimension, "value": float(s.value), "trend": s.trend,
                       "updated_at": iso(s.updated_at)} for s in scores],
            "notebook": [{"section": n.section, "body": n.body, "author": n.author, "created_at": iso(n.created_at)}
                        for n in notes]}


class DataRequestIn(BaseModel):
    kind: Literal["export", "erase", "restrict"]


@router.post("/persons/{person_id}/data-requests", status_code=201)
async def create_data_request(person_id: uuid.UUID, body: DataRequestIn, user: service.CurrentUser = Depends(MANAGE),
                              _pin: Any = Depends(require_pin("data.export_delete")), db: AsyncSession = DB
                              ) -> dict[str, Any]:
    """Yêu cầu xuất / xoá / giới hạn dữ liệu một người (spec I, `ops.data_requests`). `erase` xoá/ẩn danh dữ liệu
    suy ra (điểm số, sổ tay, số điện thoại/handle) — KHÔNG đụng `raw.events` (khoá cứng #5, chỉ-INSERT); tin thô
    vẫn còn nhưng người đã ẩn danh, không còn định danh được ngược từ Console."""
    person = await _person_row(db, user.org_id, person_id)
    req_id = (await db.execute(text("""INSERT INTO ops.data_requests (org_id, person_id, kind, status)
                                       VALUES (:o, :p, :k, 'open') RETURNING id"""),
                               {"o": user.org_id, "p": person_id, "k": body.kind})).scalar_one()
    result: dict[str, Any]
    if body.kind == "export":
        result = await _export_person_bundle(db, person)
    elif body.kind == "erase":
        await db.execute(text("""UPDATE core.persons SET display_name = 'Người dùng đã xoá', attrs = '{}'::jsonb,
                                 deleted_at = now() WHERE id = :i"""), {"i": person_id})
        await db.execute(text("""UPDATE core.person_identities SET handle = NULL, phone_e164 = NULL
                                 WHERE person_id = :i"""), {"i": person_id})
        await db.execute(text("DELETE FROM clean.current_scores WHERE subject_type = 'person' AND subject_id = :i"),
                         {"i": person_id})
        await db.execute(text("""DELETE FROM memory.entries WHERE notebook_id IN
                                 (SELECT id FROM memory.notebooks
                                   WHERE subject_type = 'person' AND subject_id = :i)"""), {"i": person_id})
        result = {"erased": True}
    else:
        await db.execute(text("""UPDATE core.persons SET attrs = attrs || '{"data_restricted": true}'::jsonb
                                 WHERE id = :i"""), {"i": person_id})
        result = {"restricted": True}
    await db.execute(text("UPDATE ops.data_requests SET status = 'completed', completed_at = now() WHERE id = :i"),
                     {"i": req_id})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action=f"person_data.{body.kind}", target_type="person", target_id=person.code,
                           target_label=person.display_name, detail={"request_id": str(req_id)}, ip=user.ip)
    return {"id": str(req_id), "kind": body.kind, "status": "completed", "result": result}


@router.get("/persons/{person_id}/data-requests")
async def list_data_requests(person_id: uuid.UUID, user: service.CurrentUser = Depends(READ), db: AsyncSession = DB
                             ) -> list[dict[str, Any]]:
    await _person_row(db, user.org_id, person_id)
    rows = (await db.execute(text("""SELECT id, kind, status, requested_at, completed_at FROM ops.data_requests
                                     WHERE org_id = :o AND person_id = :p ORDER BY requested_at DESC"""),
                             {"o": user.org_id, "p": person_id})).all()
    return [{"id": str(r.id), "kind": r.kind, "status": r.status, "requested_at": iso(r.requested_at),
             "completed_at": iso(r.completed_at)} for r in rows]


__all__ = ["router", "channel_card", "update_group", "GroupPatch", "provider_payloads", "LISTEN_MODES", "VIEW_SCOPES",
           "GROUP_KINDS", "PROVIDER_KINDS"]
