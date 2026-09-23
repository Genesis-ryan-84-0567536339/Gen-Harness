"""Điều khiển hệ thống › Kênh & đăng nhập; nhà cung cấp model, khoá; hồ sơ Antigravity CLI (docs/api/phase-2.md)."""

import uuid
from datetime import UTC, datetime
from typing import Any, Literal

import orjson
from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh import crypto, realtime
from gh.auth import service
from gh.auth.deps import require, require_pin
from gh.chassis import actionlog
from gh.chassis.bus import BRIDGE_CONTROL
from gh.data.common import CHANNEL_NAME, LISTENING_MODES, iso, org_settings
from gh.data.ingest import sync_listen_sets, uptime_pct
from gh.db import get_db
from gh.errors import ApiError, conflict, field_errors, not_found
from gh.providers import cli as climod
from gh.providers.router import KEY_AAD, cooldown_key, quota_key

router = APIRouter(tags=["system"])
READ = require("system.read")
MANAGE = require("system.manage")

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
                   db: AsyncSession = Depends(get_db)) -> list[dict[str, Any]]:
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
                        db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
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
                         db: AsyncSession = Depends(get_db)) -> Response:
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
                        db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
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
                         db: AsyncSession = Depends(get_db)) -> list[dict[str, Any]]:
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
    r = (await db.execute(text(GROUP_SELECT + " WHERE g.id = :i"), {"i": gid})).one()
    return _group_out(r)


@router.patch("/groups/{gid}")
async def patch_group(gid: uuid.UUID, body: GroupPatch, request: Request, user: service.CurrentUser = Depends(MANAGE),
                      db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
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
                    db: AsyncSession = Depends(get_db)) -> list[dict[str, Any]]:
    return await provider_payloads(db, request.app.state.redis, user.org_id)


@router.post("/providers", status_code=201)
async def create_provider(body: ProviderIn, request: Request, user: service.CurrentUser = Depends(MANAGE),
                          db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
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


@router.patch("/providers/{pid}")
async def patch_provider(pid: uuid.UUID, body: ProviderPatch, request: Request,
                         user: service.CurrentUser = Depends(MANAGE), db: AsyncSession = Depends(get_db)
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
                  db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
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
                     db: AsyncSession = Depends(get_db)) -> Response:
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
                    db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
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
                        db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    p = await _provider(db, user.org_id, pid)
    await db.commit()
    result: dict[str, Any] = await request.app.state.model_router.test_provider(pid)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id, action="provider.tested",
                           target_type="provider", target_id=str(pid), target_label=p.name,
                           result="ok" if result["ok"] else "failed", detail={"error": result["error"]}, ip=user.ip)
    return result


@router.get("/providers/credentials")
async def credentials(request: Request, user: service.CurrentUser = Depends(READ),
                      db: AsyncSession = Depends(get_db)) -> list[dict[str, Any]]:
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
                       db: AsyncSession = Depends(get_db)) -> list[dict[str, Any]]:
    return await climod.profiles(db, user.org_id)


@router.post("/cli/login", status_code=202)
async def cli_login(request: Request, user: service.CurrentUser = Depends(MANAGE),
                    db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
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
                       db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    out = await climod.activate(db, user.org_id, profile_id)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="cli.account_switched", target_type="cli_profile", target_id=out["id"],
                           target_label=out["email"], ip=user.ip)
    return next(p for p in await climod.profiles(db, user.org_id) if p["id"] == out["id"])


@router.delete("/cli/profiles/{profile_id}", status_code=204)
async def cli_delete(profile_id: uuid.UUID, user: service.CurrentUser = Depends(MANAGE),
                     _pin: Any = Depends(require_pin("cli.switch_account")),
                     db: AsyncSession = Depends(get_db)) -> Response:
    out = await climod.delete_profile(db, user.org_id, profile_id)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="cli.profile_deleted", target_type="cli_profile", target_id=str(profile_id),
                           target_label=out["email"], detail={"was_active": out["was_active"]}, ip=user.ip)
    return Response(status_code=204)


__all__ = ["router", "channel_card", "update_group", "GroupPatch", "provider_payloads", "LISTEN_MODES", "VIEW_SCOPES",
           "GROUP_KINDS", "PROVIDER_KINDS"]
