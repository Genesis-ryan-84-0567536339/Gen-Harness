"""Liên kết Gen-hub — Gen ĐỌC Kho Ryan (v0.1.26, docs/design/gen-hub-link.md §3).

- Liên kết (`agent.hub_links`, một dòng / tổ chức) trỏ tới một máy chủ trong MCP Hub sẵn có (`agent.mcp_servers`);
  token agent của Gen-hub mã hoá phong bì trong `mcp_servers.auth_enc` (gh.crypto) — không lưu rõ, không log, không
  trả qua API. Mọi lời gọi ra ngoài đi qua `gh.mcp_api.invoke.invoke_tool` (không có đường gọi MCP thứ hai).
- Chỉ-đọc, 2 lớp: Gen-hub chỉ grant tool đọc Kho; ở đây chỉ gọi tool có hậu tố thuộc `KHO_READ_SUFFIXES` (so hậu tố
  vì Gen-hub đặt tiền tố theo connector, vd `mcp-58450__kho_tom_tat`) — tool lạ bị bỏ qua dù Owner lỡ mở.
- Nội dung Kho sang model đám mây (quyết định Boss #2) → luôn qua `mask_for_model` (gen-v1 §9.2: cùng lớp che
  `mask_text` như vai trò dưới Owner + che email, khoá/token) TRƯỚC khi trả về, lưu đệm hay ghi `mcp_calls`.
- Đệm Redis 5 phút theo org + tool + tham số (chỉ bản đã che); đổi địa chỉ/token → xoá đệm.
"""

import hashlib
import ipaddress
import re
import socket
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlparse

import orjson
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh import notifications
from gh.auth import rbac, service
from gh.chassis import actionlog
from gh.chassis.mcp_client import McpClient
from gh.data.common import iso, mask_text
from gh.errors import ApiError, conflict
from gh.mcp_api import invoke

AGENT_KEY = "core.gen"
SERVER_NAME = "Gen-hub"
SERVER_NOTE = "Liên kết Gen-hub — Gen đọc Kho Ryan (chỉ đọc). Quản lý ở thẻ Gen-hub."
# Danh sách cho phép cố định trong code (không cấu hình được): chỉ tool ĐỌC Kho.
KHO_READ_SUFFIXES = ("kho_tom_tat", "kho_search", "kho_get", "kho_find_by_id", "kho_list")
REQUIRED_SUFFIXES = ("kho_tom_tat", "kho_search", "kho_find_by_id")
RECORD_RE = re.compile(r"^[A-Z]{2,6}-\d{1,6}$")
CACHE_TTL_S = 300
EXPIRY_WARN_DAYS = 14
CALL_TIMEOUT_S = 10.0


# ─── che dữ liệu trước khi sang model (gen-v1 §9.2) ───────────────────────────

_RE_LONGNUM = re.compile(r"(?<!\d)(\d[\d .-]{7,22}\d)(?!\d)")
_RE_DATE = re.compile(r"\d{4}-\d{1,2}-\d{1,2}(?: \d{1,2})?|\d{1,2}[.-]\d{1,2}[.-]\d{4}")
_RE_EMAIL = re.compile(r"\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")
_RE_SECRET = re.compile(
    r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}"
    r"|\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|glpat|AIza|ya29|ghh|gha)[-_.][A-Za-z0-9._-]{8,}"
    r"|\bAIza[A-Za-z0-9_-]{20,}"
    r"|\b[A-Za-z0-9_-]{40,}\b")
_SECRET_KEYS = re.compile(
    r"(?i)(?:^|[_\s-])(?:password|passwd|mat_?khau|mật khẩu|secret|token|api_?key|pin)(?:$|[_\s-])")
MASK = "[đã che]"


def _mask_str(s: str, extra: tuple[str, ...]) -> str:
    for secret in extra:
        if secret:
            s = s.replace(secret, MASK)
    s = _RE_SECRET.sub(MASK, s)
    s = _RE_EMAIL.sub(lambda m: f"{m.group(1)}•••@{m.group(2)}", s)

    def num(m: re.Match[str]) -> str:
        whole = m.group(1)
        if _RE_DATE.fullmatch(whole.strip()):
            return whole  # ngày tháng không phải dữ liệu nhạy cảm — Kho dùng rất nhiều
        return mask_text(whole, False) or whole

    return _RE_LONGNUM.sub(num, s)


def mask_for_model(data: Any, *, secrets: tuple[str, ...] = ()) -> Any:
    """Che đệ quy mọi chuỗi: số dài ≥ 8 chữ số (tài khoản, thẻ, SĐT — trừ ngày), email, khoá/token; giá trị của
    khoá có tên kiểu mật khẩu/token bị thay hẳn. `secrets` = chuỗi phải xoá tuyệt đối (token của chính liên kết)."""
    if isinstance(data, str):
        return _mask_str(data, secrets)
    if isinstance(data, list):
        return [mask_for_model(v, secrets=secrets) for v in data]
    if isinstance(data, dict):
        out: dict[str, Any] = {}
        for k, v in data.items():
            key = str(k)
            if _SECRET_KEYS.search(key) and isinstance(v, str | int) and not isinstance(v, bool) and v != "":
                out[key] = MASK
            else:
                out[key] = mask_for_model(v, secrets=secrets)
        return out
    return data


def endpoint_forbidden(endpoint: str) -> bool:
    """Chống SSRF tới dịch vụ siêu dữ liệu đám mây / địa chỉ đặc biệt: host phân giải ra link-local (169.254.x,
    fe80::), unspecified (0.0.0.0) hay multicast → cấm, bất kể công tắc mạng công cộng. LAN/loopback vẫn theo guard
    MCP Hub sẵn có (Gen-hub có thể chạy cùng mạng nội bộ)."""
    host = urlparse(endpoint).hostname
    if not host:
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False  # không phân giải được → guard mạng MCP Hub xử lý (coi là công cộng → chặn khi công tắc tắt)
    for info in infos:
        try:
            ip = ipaddress.ip_address(str(info[4][0]).split("%", 1)[0])
        except ValueError:
            continue
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        if ip.is_link_local or ip.is_unspecified or ip.is_multicast:
            return True
    return False


ENDPOINT_FORBIDDEN_MSG = "Địa chỉ Gen-hub trỏ tới vùng mạng bị cấm (link-local/siêu dữ liệu đám mây)"
ENDPOINT_INVALID_MSG = "Địa chỉ Gen-hub không hợp lệ — kiểm tra lại (dạng https://hub.genos.top/mcp)"


def _summary(suffix: str, result: Any) -> str:
    """`mcp_calls.result_summary` + sự kiện WS `mcp.call` đi tới cả vai trò `system.read` — Kho chỉ cho Owner
    (quyết định Boss #1) nên KHÔNG lưu nội dung, chỉ siêu dữ liệu."""
    return f"Đọc Kho ({suffix}) — {len(orjson.dumps(result))} byte, nội dung không lưu"


def scrub(message: str, token: str | None) -> str:
    """Lỗi từ máy chủ ngoài có thể lặp lại header — không bao giờ để token lọt vào last_error / phản hồi / log."""
    msg = message.replace(token, MASK) if token else message
    return _RE_SECRET.sub(MASK, msg)[:300]


# ─── liên kết ─────────────────────────────────────────────────────────────────

LINK_SELECT = """
SELECT l.org_id, l.server_id, l.enabled, l.token_expires_at, l.expiry_notified_at, l.last_ok_at, l.last_error,
       l.updated_at, s.endpoint, s.allow_public_network, s.is_enabled AS server_enabled, s.health,
       (s.auth_enc IS NOT NULL) AS has_token
FROM agent.hub_links l LEFT JOIN agent.mcp_servers s ON s.id = l.server_id
WHERE l.org_id = :o
"""


async def load(db: AsyncSession, org_id: uuid.UUID) -> Any:
    return (await db.execute(text(LINK_SELECT), {"o": org_id})).one_or_none()


def status_of(r: Any, now: datetime | None = None) -> str:
    """off (chưa cấu hình / chưa kiểm tra / đã tắt) · ok · expiring (≤ 14 ngày) · expired · error."""
    now = now or datetime.now(UTC)
    if r is None or r.server_id is None:
        return "off"
    if r.last_error and r.last_error.startswith(("401", "403")):
        return "expired"
    if r.token_expires_at is not None and r.token_expires_at <= now:
        return "expired"
    if not r.enabled:
        return "off"
    if r.last_error:
        return "error"
    if r.token_expires_at is not None and r.token_expires_at <= now + timedelta(days=EXPIRY_WARN_DAYS):
        return "expiring"
    return "ok"


LAST_ERROR_HIDDEN = "Gen-hub đang lỗi — Owner xem chi tiết ở thẻ Gen-hub"


def link_out(r: Any, *, owner: bool = True) -> dict[str, Any]:
    """Không bao giờ có token — chỉ `has_token`. `last_error` (lỗi thô từ Gen-hub, đã lọc token) chỉ Owner thấy;
    vai trò `system.read` khác (Kiểm toán) nhận một câu chung (v0.1.27)."""
    if r is None:
        return {"configured": False, "enabled": False, "status": "off", "server_id": None, "endpoint": None,
                "has_token": False, "allow_public_network": False, "token_expires_at": None, "days_left": None,
                "last_ok_at": None, "last_error": None, "health": None}
    days_left = None
    if r.token_expires_at is not None:
        days_left = max(0, (r.token_expires_at - datetime.now(UTC)).days)
    return {"configured": r.server_id is not None, "enabled": bool(r.enabled and r.server_id is not None),
            "status": status_of(r), "server_id": str(r.server_id) if r.server_id else None, "endpoint": r.endpoint,
            "has_token": bool(r.has_token), "allow_public_network": bool(r.allow_public_network),
            "token_expires_at": iso(r.token_expires_at), "days_left": days_left, "last_ok_at": iso(r.last_ok_at),
            "last_error": r.last_error if owner else (LAST_ERROR_HIDDEN if r.last_error else None),
            "health": r.health}


def cache_prefix(org_id: uuid.UUID) -> str:
    return f"gh:hub:kho:{org_id}:"


def cache_key(org_id: uuid.UUID, suffix: str, args: dict[str, Any]) -> str:
    digest = hashlib.sha256(orjson.dumps({"t": suffix, "a": args}, option=orjson.OPT_SORT_KEYS)).hexdigest()[:24]
    return cache_prefix(org_id) + digest


async def clear_cache(redis: Any, org_id: uuid.UUID) -> None:
    if redis is None:
        return
    keys = [k async for k in redis.scan_iter(match=cache_prefix(org_id) + "*", count=200)]
    if keys:
        await redis.delete(*keys)


def suffix_of(tool_name: str) -> str | None:
    """Hậu tố cho phép của một tool Gen-hub (`kho_tom_tat` hoặc `<connector>__kho_tom_tat`), None nếu tool lạ."""
    base = tool_name.rsplit("__", 1)[-1]
    return base if base in KHO_READ_SUFFIXES else None


async def find_tool(db: AsyncSession, org_id: uuid.UUID, server_id: uuid.UUID, suffix: str) -> Any:
    assert suffix in KHO_READ_SUFFIXES
    rows = (await db.execute(text(invoke.TOOL_SELECT + " WHERE t.server_id = :s AND s.org_id = :o ORDER BY t.name"),
                             {"s": server_id, "o": org_id})).all()
    for r in rows:
        if suffix_of(r.name) == suffix:
            return r
    return None


async def _set_result(db: AsyncSession, org_id: uuid.UUID, *, ok: bool, error: str | None = None,
                      enable: bool = False) -> None:
    if ok:
        await db.execute(text(f"""UPDATE agent.hub_links SET last_ok_at = now(), last_error = NULL
                                  {', enabled = true' if enable else ''} WHERE org_id = :o"""),  # noqa: S608
                         {"o": org_id})
    else:
        await db.execute(text("UPDATE agent.hub_links SET last_error = :e WHERE org_id = :o"),
                         {"e": error, "o": org_id})


PUBLIC_NET_HINT = "Bật 'Cho phép Gen-hub ở mạng công cộng' ngay trong thẻ này."


def _classify(message: str, code: str | None = None) -> str:
    """Lỗi McpClient dạng "<mã HTTP>: …" / "mạng: …" → câu ngắn tiếng Việt, giữ mã đầu dòng cho `status_of`.

    v0.1.39 (F-31): guard mạng MCP Hub (`MCP_NETWORK_BLOCKED`) chặn vì địa chỉ ở mạng công cộng → chỉ đúng công tắc
    trong thẻ Gen-hub (server KHÔNG tự bật); chặn vì link-local/siêu dữ liệu → câu vùng mạng bị cấm; địa chỉ sai dạng
    (scheme lạ, cổng ngoài 0–65535) → câu "không hợp lệ" riêng (trước đây bị gán nhầm "vùng mạng bị cấm")."""
    if code == "MCP_NETWORK_BLOCKED":
        if "mạng công cộng" in message:
            return PUBLIC_NET_HINT
        if "vùng mạng bị cấm" in message:
            return ENDPOINT_FORBIDDEN_MSG
        return ENDPOINT_INVALID_MSG
    head = message.split(":", 1)[0].strip()
    if head in ("401", "403"):
        return f"{head}: Token Gen-hub hết hạn hoặc đã bị thu hồi — tạo token mới trong Gen-hub rồi dán lại"
    if head == "429":
        return "429: Gen-hub đang giới hạn lượt gọi — thử lại sau vài phút"
    if head == "mạng":
        return "Không kết nối được Gen-hub (mạng/timeout)"
    return message


def _error_code(msg: str, *, code: str | None = None, missing: bool = False) -> str:
    """Mã lỗi thống nhất cho trang "Việc Sếp cần làm" (v0.1.39) — đọc từ câu đã phân loại."""
    if msg == ENDPOINT_FORBIDDEN_MSG:
        return "HUB_ENDPOINT_FORBIDDEN"
    if msg == ENDPOINT_INVALID_MSG:
        return "HUB_ENDPOINT_INVALID"
    if msg == PUBLIC_NET_HINT or code == "MCP_NETWORK_BLOCKED":
        return "MCP_NETWORK_BLOCKED"
    if missing:
        return "HUB_TOOLS_MISSING"
    head = msg.split(":", 1)[0].strip()
    if head in ("401", "403"):
        return "HUB_TOKEN_REJECTED"
    if head == "429":
        return "HUB_RATE_LIMITED"
    if msg.startswith("Không kết nối được Gen-hub"):
        return "HUB_UNREACHABLE"
    return "HUB_ERROR"


def client_for(transport: Any) -> McpClient:
    """Mọi lời gọi Gen-hub ghim DNS (v0.1.27): phân giải một lần, kiểm IP, kết nối thẳng IP đã kiểm — đóng cửa sổ
    DNS rebinding giữa `endpoint_forbidden`/guard mạng và lúc kết nối thật."""
    return McpClient(transport=transport, timeout=CALL_TIMEOUT_S, pin_dns=True)


async def call_kho(db: AsyncSession, redis: Any, client: McpClient, *, user: service.CurrentUser, suffix: str,
                   args: dict[str, Any]) -> dict[str, Any]:
    """Một lần đọc Kho cho Gen/Owner. Kết quả LUÔN đã che (mask_for_model)."""
    if suffix not in KHO_READ_SUFFIXES:
        raise conflict("HUB_TOOL_NOT_ALLOWED", "Tool này không nằm trong danh sách đọc Kho được phép")
    link = await load(db, user.org_id)
    if link is None or link.server_id is None or not link.enabled:
        raise conflict("HUB_LINK_OFF", "Chưa nối Gen-hub — Sếp cấu hình ở Kết nối › thẻ Gen-hub rồi bấm Kiểm tra")
    key = cache_key(user.org_id, suffix, args)
    if redis is not None:
        raw = await redis.get(key)
        if raw:
            return {"source": "Kho Ryan qua Gen-hub", "tool": suffix, "cached": True, "data": orjson.loads(raw)}
    tool = await find_tool(db, user.org_id, link.server_id, suffix)
    if tool is None:
        raise conflict("HUB_TOOL_MISSING", f"Gen-hub chưa cấp tool {suffix} — bấm Kiểm tra ở thẻ Gen-hub")
    if endpoint_forbidden(link.endpoint or ""):
        raise conflict("HUB_BLOCKED", "Kho đang bị chặn bởi rào chắn MCP Hub", ENDPOINT_FORBIDDEN_MSG)
    token = await invoke.auth_token(db, link.server_id)
    secrets = (token,) if token else ()
    try:
        out = await invoke.invoke_tool(db, redis, client, org_id=user.org_id, tool=tool, agent_key=AGENT_KEY,
                                       args=args, actor=user, summarize=lambda r: _summary(suffix, r))
    except invoke.McpCallFailed as e:
        msg = scrub(_classify(str(e.cause)), token)
        await _set_result(db, user.org_id, ok=False, error=msg)
        await db.commit()
        raise conflict("HUB_UNAVAILABLE", "Chưa đọc được Kho lúc này", msg) from e
    except ApiError as e:
        # Bị chặn bởi guard MCP Hub (máy chủ tắt, tool đóng/chưa cấp, chặn mạng, mức tự trị) — log đã commit.
        msg = scrub(str(e.detail or e.title), token)
        await _set_result(db, user.org_id, ok=False, error=msg)
        await db.commit()
        raise conflict("HUB_BLOCKED", "Kho đang bị chặn bởi rào chắn MCP Hub", msg) from e
    if out["outcome"] != "ok":
        await db.commit()  # giữ bản nháp mcp_write + log trước khi báo lỗi (route ném → rollback)
        raise conflict("HUB_TOOL_HELD", "Tool đang ở loại ghi — đã tạo bản nháp chờ duyệt, không gọi ra ngoài")
    data = mask_for_model(out["result"], secrets=secrets)
    if redis is not None:
        await redis.set(key, orjson.dumps(data), ex=CACHE_TTL_S)
    await _set_result(db, user.org_id, ok=True)
    return {"source": "Kho Ryan qua Gen-hub", "tool": suffix, "cached": False, "data": data}


async def is_hub_server(db: AsyncSession, org_id: uuid.UUID, server_id: uuid.UUID) -> bool:
    link = await load(db, org_id)
    return link is not None and link.server_id is not None and link.server_id == server_id


async def guard_server_admin(db: AsyncSession, *, user: service.CurrentUser, server_id: uuid.UUID,
                             action: str) -> bool:
    """Route chung sửa/xoá/khám phá máy chủ MCP (`system.manage` — vai trò tuỳ biến có thể có) KHÔNG được đụng máy
    chủ của liên kết Gen-hub nếu không phải Owner: đổi `endpoint` rồi khám phá/gọi = gửi token Kho tới nơi khác.
    Trả True khi đó là máy chủ Gen-hub (bên gọi dùng client ghim DNS)."""
    if not await is_hub_server(db, user.org_id, server_id):
        return False
    if user.role_code != rbac.OWNER:
        msg = "Bị chặn: máy chủ Gen-hub (Kho Ryan) chỉ Owner được quản lý"
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="mcp.server_blocked", target_type="mcp_server", target_id=str(server_id),
                               target_label=SERVER_NAME, result="blocked",
                               detail={"code": "HUB_OWNER_ONLY", "reason": msg, "op": action}, ip=user.ip)
        await db.commit()
        raise ApiError(403, "HUB_OWNER_ONLY", "Bị chặn", msg)
    return True


async def generic_call(db: AsyncSession, redis: Any, transport: Any, *, user: service.CurrentUser, tool: Any,
                       agent_key: str, args: dict[str, Any]) -> dict[str, Any] | None:
    """Route chung `POST /mcp/tools/{id}/call` gọi vào máy chủ của liên kết Gen-hub (v0.1.27): Kho chỉ Owner
    (quyết định Boss #1) → vai trò khác bị chặn (403 `HUB_OWNER_ONLY`, có log); Owner thì đi đúng đường của liên
    kết — ghim DNS, `mcp_calls` chỉ siêu dữ liệu, kết quả đã che. Trả None khi tool không thuộc Gen-hub."""
    link = await load(db, user.org_id)
    if link is None or link.server_id is None or link.server_id != tool.server_id:
        return None
    if user.role_code != rbac.OWNER:
        msg = "Bị chặn: máy chủ Gen-hub (Kho Ryan) chỉ Owner được gọi"
        item = await invoke.log_call(db, redis, org_id=user.org_id, tool_id=tool.id, agent_key=agent_key, args=args,
                                     outcome="blocked", result_summary=msg, latency_ms=0)
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="mcp.call_blocked", target_type="mcp_tool", target_id=str(tool.id),
                               target_label=f"{tool.server_name} · {tool.name}", result="blocked",
                               detail={"code": "HUB_OWNER_ONLY", "reason": msg, "agent_key": agent_key}, ip=user.ip)
        await db.commit()
        raise ApiError(403, "HUB_OWNER_ONLY", "Bị chặn", msg, call=item)
    label = suffix_of(tool.name) or tool.name
    token = await invoke.auth_token(db, link.server_id)
    try:
        out = await invoke.invoke_tool(db, redis, client_for(transport), org_id=user.org_id, tool=tool,
                                       agent_key=agent_key, args=args, actor=user,
                                       summarize=lambda r: _summary(label, r))
    except invoke.McpCallFailed as e:
        raise invoke.McpCallFailed(e.cause, scrub(str(e.title), token)) from e
    if out["outcome"] == "ok":
        out["result"] = mask_for_model(out["result"], secrets=(token,) if token else ())
    return out


# ─── cấu hình + kiểm tra ──────────────────────────────────────────────────────

async def upsert(db: AsyncSession, redis: Any, *, user: service.CurrentUser, endpoint: str | None,
                 token: str | None, token_expires_at: datetime | None, set_expiry: bool,
                 allow_public_network: bool | None, disable: bool) -> Any:
    cur = await load(db, user.org_id)
    changed: list[str] = []
    server_id = cur.server_id if cur is not None else None
    if server_id is None:
        if not endpoint or not token:
            raise ApiError(422, "VALIDATION", "Dữ liệu chưa hợp lệ",
                           errors={"endpoint": "Cần địa chỉ Gen-hub và token cho lần nối đầu"})
        server_id = (await db.execute(text("""
            INSERT INTO agent.mcp_servers (org_id, name, transport, endpoint, auth_enc, allow_public_network, note)
            VALUES (:o, :n, 'streamable_http', :e, :a, :pub, :note) RETURNING id"""),
            {"o": user.org_id, "n": SERVER_NAME, "e": endpoint, "a": invoke.encrypt_token(token),
             "pub": bool(allow_public_network), "note": SERVER_NOTE})).scalar_one()
        changed += ["endpoint", "token"] + (["allow_public_network"] if allow_public_network else [])
    else:
        sets: list[str] = []
        params: dict[str, Any] = {"i": server_id}
        if endpoint is not None and endpoint != cur.endpoint:
            sets.append("endpoint = :e")
            params["e"] = endpoint
            changed.append("endpoint")
        if token:
            sets.append("auth_enc = :a")
            params["a"] = invoke.encrypt_token(token)
            changed.append("token")
        if allow_public_network is not None and allow_public_network != cur.allow_public_network:
            sets.append("allow_public_network = :pub")
            params["pub"] = allow_public_network
            changed.append("allow_public_network")
        if sets:
            await db.execute(text(f"UPDATE agent.mcp_servers SET {', '.join(sets)} WHERE id = :i"),  # noqa: S608
                             params)
    if set_expiry:
        changed.append("token_expires_at")
    if disable:
        changed.append("enabled")
    relink = any(k in changed for k in ("endpoint", "token", "allow_public_network"))
    await db.execute(text("""
        INSERT INTO agent.hub_links (org_id, server_id, enabled, token_expires_at, updated_by, updated_at)
        VALUES (:o, :s, false, :exp, :u, now())
        ON CONFLICT (org_id) DO UPDATE SET
          server_id = EXCLUDED.server_id,
          enabled = CASE WHEN :off THEN false ELSE agent.hub_links.enabled END,
          token_expires_at = CASE WHEN :setexp THEN EXCLUDED.token_expires_at
                                  ELSE agent.hub_links.token_expires_at END,
          expiry_notified_at = CASE WHEN :setexp OR :tok THEN NULL ELSE agent.hub_links.expiry_notified_at END,
          last_error = CASE WHEN :relink THEN NULL ELSE agent.hub_links.last_error END,
          updated_by = EXCLUDED.updated_by, updated_at = now()"""),
        {"o": user.org_id, "s": server_id, "exp": token_expires_at, "u": user.id,
         "off": disable or relink, "setexp": set_expiry, "tok": "token" in changed, "relink": relink})
    if relink or disable:
        await clear_cache(redis, user.org_id)
    if changed:
        detail: dict[str, Any] = {"changed": changed}
        if "token" in changed:
            detail["token"] = "(đã đổi)"
        if set_expiry:
            detail["token_expires_at"] = iso(token_expires_at)
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="hub.link_disabled" if changed == ["enabled"] else "hub.link_updated",
                               target_type="hub_link", target_id=str(server_id), target_label=SERVER_NAME,
                               detail=detail, ip=user.ip)
    return await load(db, user.org_id)


async def test_link(db: AsyncSession, redis: Any, client: McpClient, *, user: service.CurrentUser) -> dict[str, Any]:
    """Khám phá tool → mở + cấp `core.gen` ĐÚNG các tool đọc Kho (hậu tố cho phép, loại `read`) → gọi `kho_tom_tat`.
    Xanh → bật liên kết. Không ném lỗi khi Gen-hub lỗi: trả `{ok: false, error}` để thẻ hiện lý do."""
    link = await load(db, user.org_id)
    if link is None or link.server_id is None:
        raise conflict("HUB_LINK_NOT_CONFIGURED", "Chưa nhập địa chỉ và token Gen-hub")
    server = await invoke.get_server(db, user.org_id, link.server_id)
    token = await invoke.auth_token(db, link.server_id)
    started = time.monotonic()

    async def fail(msg: str, *, code: str | None = None, tools_missing: bool = False, **extra: Any) -> dict[str, Any]:
        error_code = _error_code(msg, code=code, missing=tools_missing)
        msg = scrub(msg, token)
        await _set_result(db, user.org_id, ok=False, error=msg)
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="hub.link_tested", target_type="hub_link", target_id=str(link.server_id),
                               target_label=SERVER_NAME, result="failed", detail={"error": msg, **extra}, ip=user.ip)
        await db.commit()
        return {"ok": False, "error": msg, "error_code": error_code,
                "latency_ms": int((time.monotonic() - started) * 1000), "exposed_tools": [],
                "missing_tools": list(extra.get("missing_tools", [])), "link": link_out(await load(db, user.org_id))}

    if endpoint_forbidden(server.endpoint or ""):
        return await fail(ENDPOINT_FORBIDDEN_MSG)
    try:
        found = await invoke.discover(db, redis, client, org_id=user.org_id, server=server, actor=user)
    except ApiError as e:
        return await fail(_classify(str(e.title), code=e.code), code=e.code)
    exposed: list[str] = []
    write_kho: list[str] = []
    have: set[str] = set()
    for t in found:
        suf = suffix_of(t["name"])
        if suf is None:
            continue  # tool lạ (Vault, kho_create…): để nguyên, mặc định đóng — code cũng không bao giờ gọi
        if t["access"] != "read":
            write_kho.append(t["name"])
            continue
        have.add(suf)
        tid = uuid.UUID(t["id"])
        if not t["is_exposed"]:
            await db.execute(text("UPDATE agent.mcp_tools SET is_exposed = true WHERE id = :i"), {"i": tid})
            await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                                   action="mcp.tool_exposed", target_type="mcp_tool", target_id=str(tid),
                                   target_label=f"{SERVER_NAME} · {t['name']}", detail={"via": "hub_link"},
                                   ip=user.ip)
        added = (await db.execute(text("""INSERT INTO agent.mcp_grants (tool_id, agent_key) VALUES (:t, :a)
                                          ON CONFLICT DO NOTHING RETURNING tool_id"""),
                                  {"t": tid, "a": AGENT_KEY})).scalar_one_or_none()
        if added is not None:
            await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                                   action="mcp.grant_added", target_type="mcp_tool", target_id=str(tid),
                                   target_label=f"{SERVER_NAME} · {t['name']}",
                                   detail={"agent_key": AGENT_KEY, "via": "hub_link"}, ip=user.ip)
        exposed.append(t["name"])
    missing = [s for s in REQUIRED_SUFFIXES if s not in have]
    if "kho_tom_tat" in missing:
        return await fail(f"Gen-hub chưa cấp tool đọc Kho: {', '.join(missing)}", missing_tools=missing,
                          write_tools=write_kho, tools_missing=True)
    tool = await find_tool(db, user.org_id, link.server_id, "kho_tom_tat")
    try:
        await invoke.invoke_tool(db, redis, client, org_id=user.org_id, tool=tool, agent_key=AGENT_KEY, args={},
                                 actor=user, summarize=lambda r: _summary("kho_tom_tat", r))
    except invoke.McpCallFailed as e:
        return await fail(_classify(str(e.cause)), missing_tools=missing)
    except ApiError as e:
        return await fail(_classify(str(e.detail or e.title), code=e.code), code=e.code, missing_tools=missing)
    await _set_result(db, user.org_id, ok=True, enable=True)
    await clear_cache(redis, user.org_id)
    latency = int((time.monotonic() - started) * 1000)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="hub.link_tested", target_type="hub_link", target_id=str(link.server_id),
                           target_label=SERVER_NAME, detail={"exposed": exposed, "missing_tools": missing,
                                                             "write_tools": write_kho, "latency_ms": latency},
                           ip=user.ip)
    return {"ok": True, "error": None, "error_code": None, "latency_ms": latency, "exposed_tools": exposed,
            "missing_tools": missing, "link": link_out(await load(db, user.org_id))}


# ─── nhắc token sắp hết hạn (worker, hằng ngày) ───────────────────────────────

async def expiry_scan(db: AsyncSession, redis: Any = None, now: datetime | None = None) -> int:
    """Token còn ≤ 14 ngày (hoặc đã hết) → chuông cho các Owner, MỘT lần cho mỗi token (đặt lại khi đổi token/hạn)."""
    now = now or datetime.now(UTC)
    rows = (await db.execute(text("""
        SELECT org_id, token_expires_at FROM agent.hub_links
        WHERE server_id IS NOT NULL AND token_expires_at IS NOT NULL AND expiry_notified_at IS NULL
          AND token_expires_at <= :lim"""), {"lim": now + timedelta(days=EXPIRY_WARN_DAYS)})).all()
    for r in rows:
        days = (r.token_expires_at - now).days
        expired = r.token_expires_at <= now
        title = "Token Gen-hub đã hết hạn" if expired else f"Token Gen-hub còn {max(days, 0)} ngày"
        body = ("Gen tạm không đọc được Kho. " if expired else "") + \
            "Tạo token mới trong Gen-hub (agent gen-harness-…) rồi dán vào Kết nối › thẻ Gen-hub, bấm Kiểm tra."
        await notifications.notify(db, r.org_id, await notifications.owner_ids(db, r.org_id),
                                   kind="hub.token_expiring", title=title, body=body, link="/connections", redis=redis)
        await db.execute(text("UPDATE agent.hub_links SET expiry_notified_at = :n WHERE org_id = :o"),
                         {"n": now, "o": r.org_id})
        await actionlog.record(db, org_id=r.org_id, actor_type="system", actor_id="system:worker",
                               action="hub.token_expiry_notified", target_type="hub_link", target_label=SERVER_NAME,
                               detail={"token_expires_at": iso(r.token_expires_at), "expired": expired})
    return len(rows)
