"""MCP Hub (PLAN 4.3, ARCHITECTURE §10): máy chủ MCP, tool tự khám phá, cấp quyền, gọi tool, nhật ký LIVE.

Khoá cứng #4 (ARCHITECTURE §7.4): tool ghi (`access='write'`) luôn qua `biz.action_drafts` trước khi thực thi
thật (tái dùng `gh.biz.core.drafts.create_draft`, KHÔNG viết lại luồng duyệt); agent chỉ gọi được tool đã được
Owner mở (`is_exposed=true`, cần PIN `mcp.expose`) VÀ được cấp (`agent.mcp_grants`) — gọi tool chưa mở/chưa cấp
luôn bị chặn và ghi vào `agent.mcp_calls`, không có cài đặt nào tắt được kiểm tra này.

Guard mạng: `agent.mcp_servers.allow_public_network` (mặc định `false` theo cột DB) — Owner bật được TỪNG máy
chủ (không phải một trong 8 khoá cứng liệt kê ở §7.4, nên không dùng `ops.policy_boundaries`); mọi lời gọi
mạng thật (khám phá tool, gọi tool đọc) đi qua `gh.chassis.mcp_client.check_network_guard` trước khi ra ngoài.

Không thuộc `gh/biz/*` — quyền theo vai trò hệ thống `system.read` / `system.manage`, cùng cách
`gh.agents_api.routes` / `gh.plugins_api.routes` dùng.
"""

import time
import uuid
from datetime import datetime
from typing import Any

import orjson
from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh import crypto, realtime
from gh.auth import rbac, service
from gh.auth.deps import require, require_pin
from gh.biz.core.drafts import create_draft, effective_level
from gh.chassis import actionlog
from gh.chassis.mcp_client import McpBlockedNetwork, McpClient, McpError, McpTransportUnsupported
from gh.data.common import iso
from gh.db import DB
from gh.errors import ApiError, conflict, field_errors, not_found

router = APIRouter(prefix="/mcp", tags=["mcp"])
READ = require("system.read", rbac.ALL)
MANAGE = require("system.manage", rbac.ALL)

MCP_AAD = b"mcp_server_auth"
TRANSPORTS = ("stdio", "http+sse", "streamable_http")
ACCESS_KINDS = ("read", "write")

realtime.register_event("mcp.call", "system.read")
realtime.register_event("mcp.server_health", "system.read")


def _client(request: Request) -> McpClient:
    return McpClient(transport=getattr(request.app.state, "mcp_transport", None))


# ─── máy chủ MCP ──────────────────────────────────────────────────────────────

class ServerIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    transport: str
    endpoint: str = Field(min_length=1, max_length=2000)
    auth_token: str | None = Field(default=None, max_length=4000)
    allow_public_network: bool = False
    note: str | None = Field(default=None, max_length=500)

    def check(self) -> None:
        if self.transport not in TRANSPORTS:
            raise field_errors({"transport": f"Chỉ nhận {', '.join(TRANSPORTS)}"})


class ServerPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    endpoint: str | None = Field(default=None, min_length=1, max_length=2000)
    auth_token: str | None = Field(default=None, max_length=4000)
    allow_public_network: bool | None = None
    is_enabled: bool | None = None
    note: str | None = Field(default=None, max_length=500)


def _server_out(r: Any) -> dict[str, Any]:
    return {"id": str(r.id), "name": r.name, "transport": r.transport, "endpoint": r.endpoint,
            "has_auth": r.auth_enc is not None, "is_enabled": r.is_enabled, "health": r.health, "note": r.note,
            "allow_public_network": r.allow_public_network, "tool_count": r.tool_count,
            "exposed_count": r.exposed_count}


SERVER_SELECT = """
SELECT s.*, (SELECT count(*) FROM agent.mcp_tools t WHERE t.server_id = s.id) AS tool_count,
       (SELECT count(*) FROM agent.mcp_tools t WHERE t.server_id = s.id AND t.is_exposed) AS exposed_count
FROM agent.mcp_servers s
"""


async def _server(db: AsyncSession, org_id: uuid.UUID, server_id: uuid.UUID) -> Any:
    r = (await db.execute(text(SERVER_SELECT + " WHERE s.id = :i AND s.org_id = :o"),
                          {"i": server_id, "o": org_id})).one_or_none()
    if r is None:
        raise not_found("Máy chủ MCP")
    return r


@router.get("/servers")
async def list_servers(user: service.CurrentUser = Depends(READ), db: AsyncSession = DB) -> list[dict[str, Any]]:
    rows = (await db.execute(text(SERVER_SELECT + " WHERE s.org_id = :o ORDER BY s.name"),
                             {"o": user.org_id})).all()
    return [_server_out(r) for r in rows]


@router.post("/servers", status_code=201)
async def create_server(body: ServerIn, user: service.CurrentUser = Depends(MANAGE),
                        db: AsyncSession = DB) -> dict[str, Any]:
    body.check()
    auth_enc = crypto.encrypt(body.auth_token.encode(), MCP_AAD) if body.auth_token else None
    sid = (await db.execute(text("""
        INSERT INTO agent.mcp_servers (org_id, name, transport, endpoint, auth_enc, allow_public_network, note)
        VALUES (:o, :n, :t, :e, :a, :pub, :note) RETURNING id"""),
        {"o": user.org_id, "n": body.name.strip(), "t": body.transport, "e": body.endpoint.strip(),
         "a": auth_enc, "pub": body.allow_public_network, "note": body.note})).scalar_one()
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="mcp.server_created", target_type="mcp_server", target_id=str(sid),
                           target_label=body.name, detail={"transport": body.transport,
                           "allow_public_network": body.allow_public_network}, ip=user.ip)
    return _server_out(await _server(db, user.org_id, sid))


@router.patch("/servers/{server_id}")
async def patch_server(server_id: uuid.UUID, body: ServerPatch, user: service.CurrentUser = Depends(MANAGE),
                       db: AsyncSession = DB) -> dict[str, Any]:
    cur = await _server(db, user.org_id, server_id)
    sets: list[str] = []
    params: dict[str, Any] = {"i": server_id}
    changed: dict[str, Any] = {}
    for k in ("name", "endpoint", "note"):
        v = getattr(body, k)
        if v is not None:
            sets.append(f"{k} = :{k}")
            params[k] = v.strip() if isinstance(v, str) else v
            changed[k] = v
    if body.allow_public_network is not None:
        sets.append("allow_public_network = :pub")
        params["pub"] = body.allow_public_network
        changed["allow_public_network"] = body.allow_public_network
    if body.is_enabled is not None:
        sets.append("is_enabled = :en")
        params["en"] = body.is_enabled
        changed["is_enabled"] = body.is_enabled
    if body.auth_token is not None:
        sets.append("auth_enc = :a")
        params["a"] = crypto.encrypt(body.auth_token.encode(), MCP_AAD) if body.auth_token else None
        changed["auth_token"] = "(đã đổi)"
    if sets:
        await db.execute(text(f"UPDATE agent.mcp_servers SET {', '.join(sets)} WHERE id = :i"), params)  # noqa: S608
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="mcp.server_updated", target_type="mcp_server", target_id=str(server_id),
                               target_label=cur.name, detail={"changed": changed}, ip=user.ip)
    return _server_out(await _server(db, user.org_id, server_id))


@router.delete("/servers/{server_id}", status_code=204)
async def delete_server(server_id: uuid.UUID, user: service.CurrentUser = Depends(MANAGE),
                        db: AsyncSession = DB) -> Response:
    cur = await _server(db, user.org_id, server_id)
    await db.execute(text("DELETE FROM agent.mcp_servers WHERE id = :i"), {"i": server_id})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="mcp.server_deleted", target_type="mcp_server", target_id=str(server_id),
                           target_label=cur.name, ip=user.ip)
    return Response(status_code=204)


async def _auth_token(db: AsyncSession, server_id: uuid.UUID) -> str | None:
    blob = (await db.execute(text("SELECT auth_enc FROM agent.mcp_servers WHERE id = :i"),
                             {"i": server_id})).scalar_one_or_none()
    return crypto.decrypt(bytes(blob), MCP_AAD).decode() if blob is not None else None


async def _set_health(db: AsyncSession, redis: Any, org_id: uuid.UUID, server_id: uuid.UUID, health: str) -> None:
    await db.execute(text("UPDATE agent.mcp_servers SET health = :h WHERE id = :i"), {"h": health, "i": server_id})
    if redis is not None:
        await realtime.publish(redis, "mcp.server_health", {"server_id": str(server_id), "health": health},
                               org_id=org_id)


@router.post("/servers/{server_id}/discover")
async def discover_tools(server_id: uuid.UUID, request: Request, user: service.CurrentUser = Depends(MANAGE),
                         db: AsyncSession = DB) -> dict[str, Any]:
    """Khám phá tool qua `tools/list`. Tool MỚI luôn vào với `is_exposed=false` (mặc định đóng, khoá cứng #4) —
    tool đã biết giữ nguyên trạng thái mở/đóng + phạm vi cấp hiện có, chỉ cập nhật mô tả/schema."""
    cur = await _server(db, user.org_id, server_id)
    if not cur.is_enabled:
        raise conflict("MCP_SERVER_DISABLED", "Máy chủ đang tắt")
    try:
        tools = await _client(request).list_tools(cur, await _auth_token(db, server_id))
    except McpBlockedNetwork as e:
        await _set_health(db, request.app.state.redis, user.org_id, server_id, "blocked")
        await db.commit()
        raise conflict("MCP_NETWORK_BLOCKED", str(e)) from e
    except McpTransportUnsupported as e:
        raise conflict("MCP_TRANSPORT_UNSUPPORTED", str(e)) from e
    except McpError as e:
        await _set_health(db, request.app.state.redis, user.org_id, server_id, "error")
        await db.commit()
        raise conflict("MCP_DISCOVER_FAILED", str(e)) from e
    found = []
    for t in tools:
        row = (await db.execute(text("""
            INSERT INTO agent.mcp_tools (server_id, name, access, schema)
            VALUES (:s, :n, :a, CAST(:sc AS jsonb))
            ON CONFLICT (server_id, name) DO UPDATE SET schema = EXCLUDED.schema
            RETURNING id, access, is_exposed, (xmax = 0) AS is_new"""),
            {"s": server_id, "n": t.name, "a": "read" if t.read_only else "write",
             "sc": orjson.dumps(t.input_schema).decode()})).one()
        found.append({"id": str(row.id), "name": t.name, "access": row.access, "is_exposed": row.is_exposed,
                     "is_new": row.is_new})
    await _set_health(db, request.app.state.redis, user.org_id, server_id, "healthy")
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="mcp.server_discovered", target_type="mcp_server", target_id=str(server_id),
                           target_label=cur.name, detail={"tool_count": len(found),
                           "new": sum(1 for f in found if f["is_new"])}, ip=user.ip)
    return {"tools": found}


# ─── tool: liệt kê, đổi loại, mở/đóng, cấp quyền ──────────────────────────────

TOOL_SELECT = """
SELECT t.id, t.server_id, t.name, t.access, t.is_exposed, t.schema, s.name AS server_name, s.org_id
FROM agent.mcp_tools t JOIN agent.mcp_servers s ON s.id = t.server_id
"""


def _tool_out(r: Any, grants: list[str] | None = None) -> dict[str, Any]:
    return {"id": str(r.id), "server_id": str(r.server_id), "server_name": r.server_name, "name": r.name,
            "access": r.access, "is_exposed": r.is_exposed, "schema": r.schema or {},
            "grants": grants if grants is not None else []}


async def _tool(db: AsyncSession, org_id: uuid.UUID, tool_id: uuid.UUID) -> Any:
    r = (await db.execute(text(TOOL_SELECT + " WHERE t.id = :i AND s.org_id = :o"),
                          {"i": tool_id, "o": org_id})).one_or_none()
    if r is None:
        raise not_found("Tool MCP")
    return r


async def _grants_of(db: AsyncSession, tool_id: uuid.UUID) -> list[str]:
    rows = (await db.execute(text("SELECT agent_key FROM agent.mcp_grants WHERE tool_id = :t ORDER BY agent_key"),
                             {"t": tool_id})).scalars().all()
    return list(rows)


@router.get("/tools")
async def list_tools(server_id: uuid.UUID | None = None, user: service.CurrentUser = Depends(READ),
                     db: AsyncSession = DB) -> list[dict[str, Any]]:
    where = " WHERE s.org_id = :o" + (" AND t.server_id = :s" if server_id else "")
    rows = (await db.execute(text(TOOL_SELECT + where + " ORDER BY s.name, t.name"),
                             {"o": user.org_id, **({"s": server_id} if server_id else {})})).all()
    return [_tool_out(r, await _grants_of(db, r.id)) for r in rows]


class ToolAccessPatch(BaseModel):
    access: str


@router.patch("/tools/{tool_id}")
async def patch_tool_access(tool_id: uuid.UUID, body: ToolAccessPatch, user: service.CurrentUser = Depends(MANAGE),
                            db: AsyncSession = DB) -> dict[str, Any]:
    if body.access not in ACCESS_KINDS:
        raise field_errors({"access": f"Chỉ nhận {', '.join(ACCESS_KINDS)}"})
    cur = await _tool(db, user.org_id, tool_id)
    await db.execute(text("UPDATE agent.mcp_tools SET access = :a WHERE id = :i"), {"a": body.access, "i": tool_id})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="mcp.tool_access_changed", target_type="mcp_tool", target_id=str(tool_id),
                           target_label=f"{cur.server_name} · {cur.name}",
                           detail={"from": cur.access, "to": body.access}, ip=user.ip)
    return _tool_out(await _tool(db, user.org_id, tool_id), await _grants_of(db, tool_id))


class ExposeIn(BaseModel):
    is_exposed: bool


@router.patch("/tools/{tool_id}/expose")
async def expose_tool(tool_id: uuid.UUID, body: ExposeIn, _: service.CurrentUser = Depends(MANAGE),
                      user: service.CurrentUser = Depends(require_pin("mcp.expose")),
                      db: AsyncSession = DB) -> dict[str, Any]:
    """Chỉ Owner (PIN `mcp.expose`) mở/đóng một tool — mặc định `is_exposed=false` (khoá cứng #4)."""
    cur = await _tool(db, user.org_id, tool_id)
    await db.execute(text("UPDATE agent.mcp_tools SET is_exposed = :e WHERE id = :i"),
                     {"e": body.is_exposed, "i": tool_id})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="mcp.tool_exposed" if body.is_exposed else "mcp.tool_hidden",
                           target_type="mcp_tool", target_id=str(tool_id),
                           target_label=f"{cur.server_name} · {cur.name}", ip=user.ip)
    return _tool_out(await _tool(db, user.org_id, tool_id), await _grants_of(db, tool_id))


class GrantIn(BaseModel):
    agent_key: str = Field(min_length=1, max_length=200)


@router.post("/tools/{tool_id}/grants", status_code=201)
async def add_grant(tool_id: uuid.UUID, body: GrantIn, user: service.CurrentUser = Depends(MANAGE),
                    db: AsyncSession = DB) -> dict[str, Any]:
    cur = await _tool(db, user.org_id, tool_id)
    await db.execute(text("""INSERT INTO agent.mcp_grants (tool_id, agent_key) VALUES (:t, :a)
                             ON CONFLICT DO NOTHING"""), {"t": tool_id, "a": body.agent_key})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="mcp.grant_added", target_type="mcp_tool", target_id=str(tool_id),
                           target_label=f"{cur.server_name} · {cur.name}", detail={"agent_key": body.agent_key},
                           ip=user.ip)
    return _tool_out(cur, await _grants_of(db, tool_id))


@router.delete("/tools/{tool_id}/grants/{agent_key}", status_code=204)
async def remove_grant(tool_id: uuid.UUID, agent_key: str, user: service.CurrentUser = Depends(MANAGE),
                       db: AsyncSession = DB) -> Response:
    cur = await _tool(db, user.org_id, tool_id)
    await db.execute(text("DELETE FROM agent.mcp_grants WHERE tool_id = :t AND agent_key = :a"),
                     {"t": tool_id, "a": agent_key})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="mcp.grant_removed", target_type="mcp_tool", target_id=str(tool_id),
                           target_label=f"{cur.server_name} · {cur.name}", detail={"agent_key": agent_key},
                           ip=user.ip)
    return Response(status_code=204)


# ─── gọi tool: khoá cứng #4 ────────────────────────────────────────────────────

OUTCOMES = ("ok", "held_for_approval", "blocked", "error")


async def _log_call(db: AsyncSession, redis: Any, *, org_id: uuid.UUID, tool_id: uuid.UUID, agent_key: str,
                    args: dict[str, Any], outcome: str, result_summary: str, latency_ms: int,
                    draft_id: uuid.UUID | None = None) -> dict[str, Any]:
    row = (await db.execute(text("""
        INSERT INTO agent.mcp_calls (org_id, tool_id, agent_key, args, result_summary, latency_ms, outcome,
                                     draft_id)
        VALUES (:o, :t, :a, CAST(:args AS jsonb), :rs, :lat, :out, :d)
        RETURNING id, at"""),
        {"o": org_id, "t": tool_id, "a": agent_key, "args": orjson.dumps(args).decode(), "rs": result_summary,
         "lat": latency_ms, "out": outcome, "d": draft_id})).one()
    item = {"id": str(row.id), "at": iso(row.at), "tool_id": str(tool_id), "agent_key": agent_key,
           "outcome": outcome, "result_summary": result_summary, "latency_ms": latency_ms,
           "draft_id": str(draft_id) if draft_id else None}
    if redis is not None:
        await realtime.publish(redis, "mcp.call", item, org_id=org_id)
    return item


def _agent_uuid(agent_key: str) -> uuid.UUID | None:
    if agent_key.startswith("agent:"):
        try:
            return uuid.UUID(agent_key[len("agent:"):])
        except ValueError:
            return None
    return None


class CallIn(BaseModel):
    agent_key: str = Field(min_length=1, max_length=200)
    args: dict[str, Any] = Field(default_factory=dict)


@router.post("/tools/{tool_id}/call")
async def call_tool(tool_id: uuid.UUID, body: CallIn, request: Request, user: service.CurrentUser = Depends(MANAGE),
                    db: AsyncSession = DB) -> dict[str, Any]:
    """Gọi một tool MCP nhân danh `agent_key`. Đúng thứ tự kiểm (khoá cứng #4, không cài đặt nào tắt được):

    máy chủ đang bật → mở (`is_exposed`) → được cấp (`agent.mcp_grants`) → guard mạng công cộng → `access`:
    `write` luôn tạo `biz.action_drafts(kind='mcp_write')` rồi DỪNG (không gọi ra ngoài); `read` gọi ngay nếu
    mức tự trị hiệu lực > 1 (không phải "chỉ ghi nhận/tóm tắt"). Mọi nhánh — kể cả bị chặn — ghi một dòng
    `agent.mcp_calls` và một dòng Action Log; không có đường nào bỏ qua log này.
    """
    t = await _tool(db, user.org_id, tool_id)
    redis = request.app.state.redis
    started = time.monotonic()

    async def blocked(code: str, msg: str) -> ApiError:
        """Ghi mcp_calls + Action Log rồi COMMIT trước khi trả lỗi — `DB` rollback toàn phiên khi route ném
        ngoại lệ (`gh.db.get_db`), nên phải chốt ghi trước, giống `gh.plugins_api.routes` làm ở nhánh lỗi."""
        item = await _log_call(db, redis, org_id=user.org_id, tool_id=tool_id, agent_key=body.agent_key,
                               args=body.args, outcome="blocked", result_summary=msg,
                               latency_ms=int((time.monotonic() - started) * 1000))
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="mcp.call_blocked", target_type="mcp_tool", target_id=str(tool_id),
                               target_label=f"{t.server_name} · {t.name}", result="blocked",
                               detail={"code": code, "reason": msg, "agent_key": body.agent_key}, ip=user.ip)
        await db.commit()
        return ApiError(403, code, "Bị chặn", msg, call=item)

    server = await _server(db, user.org_id, t.server_id)
    if not server.is_enabled:
        raise await blocked("MCP_SERVER_DISABLED", "Bị chặn: máy chủ MCP đang tắt")
    if not t.is_exposed:
        raise await blocked("MCP_TOOL_NOT_EXPOSED", "Bị chặn: tool chưa được Owner mở")
    grants = await _grants_of(db, tool_id)
    if body.agent_key not in grants:
        raise await blocked("MCP_TOOL_NOT_GRANTED", "Bị chặn: agent chưa được cấp tool này")

    if t.access == "write":
        draft = await create_draft(db, org_id=user.org_id, kind="mcp_write", title=f"Gọi tool {t.name}",
                                   body_text=f"Gọi tool MCP ghi '{t.name}' trên máy chủ '{t.server_name}' với "
                                   f"tham số {orjson.dumps(body.args).decode()}", action_key="mcp.write",
                                   agent_id=_agent_uuid(body.agent_key),
                                   sources=[{"label": t.server_name, "ref": {"type": "mcp_server",
                                            "id": str(t.server_id)}}], redis=redis)
        outcome = "held_for_approval" if draft["status"] == "pending" else "blocked"
        summary = "Chờ duyệt ở Bàn làm việc" if outcome == "held_for_approval" else (draft["hold_reason"] or
                  "Bị chặn bởi chính sách")
        item = await _log_call(db, redis, org_id=user.org_id, tool_id=tool_id, agent_key=body.agent_key,
                               args=body.args, outcome=outcome, result_summary=summary,
                               latency_ms=int((time.monotonic() - started) * 1000), draft_id=draft["id"])
        return {"outcome": outcome, "draft": draft, "call": item}

    level = await effective_level(db, user.org_id, agent_id=_agent_uuid(body.agent_key))
    if level <= 1:
        raise await blocked("MCP_AUTONOMY_TOO_LOW", f"Bị chặn: mức tự trị hiện tại ({level}) không cho gọi tool")
    try:
        result = await _client(request).call_tool(server, t.name, body.args, await _auth_token(db, server.id))
    except McpBlockedNetwork as e:
        await _set_health(db, redis, user.org_id, server.id, "blocked")
        raise await blocked("MCP_NETWORK_BLOCKED", str(e)) from e
    except McpTransportUnsupported as e:
        raise await blocked("MCP_TRANSPORT_UNSUPPORTED", str(e)) from e
    except McpError as e:
        await _set_health(db, redis, user.org_id, server.id, "error")
        item = await _log_call(db, redis, org_id=user.org_id, tool_id=tool_id, agent_key=body.agent_key,
                               args=body.args, outcome="error", result_summary=str(e)[:500],
                               latency_ms=int((time.monotonic() - started) * 1000))
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="mcp.call_error", target_type="mcp_tool", target_id=str(tool_id),
                               target_label=f"{t.server_name} · {t.name}", result="failed",
                               detail={"error": str(e)[:500]}, ip=user.ip)
        await db.commit()
        raise conflict("MCP_CALL_FAILED", str(e)) from e
    await _set_health(db, redis, user.org_id, server.id, "healthy")
    summary = orjson.dumps(result).decode()[:500]
    item = await _log_call(db, redis, org_id=user.org_id, tool_id=tool_id, agent_key=body.agent_key,
                           args=body.args, outcome="ok", result_summary=summary,
                           latency_ms=int((time.monotonic() - started) * 1000))
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id, action="mcp.call_ok",
                           target_type="mcp_tool", target_id=str(tool_id), target_label=f"{t.server_name} · {t.name}",
                           detail={"agent_key": body.agent_key}, ip=user.ip)
    return {"outcome": "ok", "result": result, "call": item}


# ─── nhật ký LIVE ──────────────────────────────────────────────────────────────

CALL_SELECT = """
SELECT c.id, c.at, c.tool_id, c.agent_key, c.args, c.result_summary, c.latency_ms, c.outcome, c.draft_id,
       t.name AS tool_name, t.access, s.name AS server_name
FROM agent.mcp_calls c JOIN agent.mcp_tools t ON t.id = c.tool_id JOIN agent.mcp_servers s ON s.id = t.server_id
"""


def _call_out(r: Any) -> dict[str, Any]:
    return {"id": str(r.id), "at": iso(r.at), "tool_id": str(r.tool_id), "tool_name": r.tool_name,
            "access": r.access, "server_name": r.server_name, "agent_key": r.agent_key, "args": r.args,
            "result_summary": r.result_summary, "latency_ms": r.latency_ms, "outcome": r.outcome,
            "draft_id": str(r.draft_id) if r.draft_id else None}


@router.get("/calls")
async def list_calls(cursor: str | None = None, limit: int = Query(50, ge=1, le=200), outcome: str | None = None,
                     user: service.CurrentUser = Depends(READ), db: AsyncSession = DB) -> dict[str, Any]:
    where = ["c.org_id = :o"]
    params: dict[str, Any] = {"o": user.org_id}
    if outcome:
        if outcome not in OUTCOMES:
            raise field_errors({"outcome": f"Chỉ nhận {', '.join(OUTCOMES)}"})
        where.append("c.outcome = :out")
        params["out"] = outcome
    if cursor:
        try:
            ts, cid = cursor.split("|")
            params["cts"], params["cid"] = datetime.fromisoformat(ts), uuid.UUID(cid)
        except ValueError as e:
            raise field_errors({"cursor": "Con trỏ không hợp lệ"}) from e
        where.append("(c.at, c.id) < (:cts, :cid)")
    w = " WHERE " + " AND ".join(where)
    rows = (await db.execute(text(CALL_SELECT + w + " ORDER BY c.at DESC, c.id DESC LIMIT :lim"),
                             {**params, "lim": limit + 1})).all()
    more = len(rows) > limit
    rows = rows[:limit]
    nxt = f"{rows[-1].at.isoformat()}|{rows[-1].id}" if more else None
    return {"items": [_call_out(r) for r in rows], "next_cursor": nxt}


__all__ = ["router"]
