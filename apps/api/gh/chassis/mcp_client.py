"""Client gọi máy chủ MCP ngoài qua JSON-RPC (ARCHITECTURE §10).

Phạm vi: chỉ hỗ trợ thật hai transport HTTP (`http+sse`, `streamable_http`) — gọi `tools/list` / `tools/call`
qua một POST JSON-RPC 2.0, đúng cách streamable-http MCP làm việc. `stdio` (chạy tiến trình con của một máy chủ
MCP bất kỳ do Owner khai báo) cần một lớp cách ly riêng như `gh.chassis.sandbox` làm cho plugin — không có
trong phạm vi cụm này; gọi `list_tools`/`call_tool` với transport này ném `McpTransportUnsupported` (ghi rõ
trong nhật ký, không thử chạy mã không kiểm soát).

Guard "Cho phép máy chủ MCP ngoài mạng nội bộ" (mặc định tắt — `agent.mcp_servers.allow_public_network`,
ARCHITECTURE §10): trước MỌI lời gọi mạng, `check_network_guard` phân giải host, chặn nếu ra IP công khai và cờ
đang tắt. Áp dụng ở đây (không chỉ ở tầng route) để không có đường nào gọi thẳng bỏ qua guard.
"""

import ipaddress
import socket
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlparse

import httpx

HTTP_TRANSPORTS = ("http+sse", "streamable_http")


class McpError(Exception):
    """Lỗi khi gọi máy chủ MCP (mạng, JSON-RPC báo lỗi, HTTP lỗi)."""


class McpBlockedNetwork(McpError):
    """Máy chủ ở mạng công cộng nhưng `allow_public_network` đang tắt (mặc định)."""


class McpTransportUnsupported(McpError):
    """Transport chưa hỗ trợ gọi thật trong phạm vi này (stdio)."""


class ServerLike(Protocol):
    transport: str
    endpoint: str
    allow_public_network: bool


@dataclass
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]
    read_only: bool | None = None   # từ annotations.readOnlyHint nếu máy chủ khai — không phải chuẩn bắt buộc


def resolves_public(host: str) -> bool:
    """True nếu host phân giải ra ít nhất một IP KHÔNG riêng/loopback/link-local (tức mạng công cộng).

    Không phân giải được → coi là rủi ro (True) để đi theo nhánh an toàn (chặn), không âm thầm cho qua.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return True
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast):
            return True
    return False


def check_network_guard(endpoint: str, allow_public_network: bool) -> None:
    if allow_public_network:
        return
    host = urlparse(endpoint).hostname or endpoint
    if resolves_public(host):
        raise McpBlockedNetwork(
            f"Máy chủ MCP ở mạng công cộng ({host}) — Owner chưa bật 'Cho phép máy chủ MCP ngoài mạng nội bộ'")


class McpClient:
    """Transport HTTP tiêm được (`transport=httpx.MockTransport(...)` trong test), cùng cách gh.providers làm."""

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None, timeout: float = 20.0):
        self._transport, self._timeout = transport, timeout

    async def _rpc(self, endpoint: str, method: str, params: dict[str, Any],
                   headers: dict[str, str]) -> Any:
        body = {"jsonrpc": "2.0", "id": "gh-1", "method": method, "params": params}
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as c:
                resp = await c.post(endpoint, json=body, headers={**headers, "content-type": "application/json"})
        except httpx.HTTPError as e:
            raise McpError(f"mạng: {e}") from e
        if resp.status_code >= 400:
            raise McpError(f"{resp.status_code}: {resp.text[:300]}")
        try:
            data = resp.json()
        except ValueError as e:
            raise McpError(f"phản hồi không phải JSON: {resp.text[:200]}") from e
        if isinstance(data, dict) and data.get("error"):
            raise McpError(str(data["error"])[:300])
        return data.get("result") if isinstance(data, dict) else data

    def _headers(self, server: ServerLike, auth_token: str | None) -> dict[str, str]:
        return {"authorization": f"Bearer {auth_token}"} if auth_token else {}

    def _check(self, server: ServerLike) -> None:
        if server.transport not in HTTP_TRANSPORTS:
            raise McpTransportUnsupported(
                f"Transport '{server.transport}' chưa hỗ trợ gọi trực tiếp trong phạm vi này")
        check_network_guard(server.endpoint, server.allow_public_network)

    async def list_tools(self, server: ServerLike, auth_token: str | None = None) -> list[ToolSpec]:
        self._check(server)
        result = await self._rpc(server.endpoint, "tools/list", {}, self._headers(server, auth_token))
        tools = (result or {}).get("tools", []) if isinstance(result, dict) else (result or [])
        out = []
        for t in tools:
            ann = t.get("annotations") or {}
            out.append(ToolSpec(name=t["name"], description=t.get("description") or "",
                                input_schema=t.get("inputSchema") or {}, read_only=ann.get("readOnlyHint")))
        return out

    async def call_tool(self, server: ServerLike, tool_name: str, args: dict[str, Any],
                        auth_token: str | None = None) -> dict[str, Any]:
        self._check(server)
        result = await self._rpc(server.endpoint, "tools/call", {"name": tool_name, "arguments": args},
                                 self._headers(server, auth_token))
        return result if isinstance(result, dict) else {"result": result}


__all__ = ["McpClient", "McpError", "McpBlockedNetwork", "McpTransportUnsupported", "ToolSpec",
          "check_network_guard", "resolves_public"]
