/**
 * Hợp đồng API giai đoạn 4 · MCP Hub (PLAN 4.3, ARCHITECTURE §10, `apps/api/gh/mcp_api/routes.py`).
 *
 * Chỉ khai báo đúng những route đã có thật ở backend — `apps/api/gh/mcp_api/routes.py` KHÔNG có
 * `/mcp/stats`, `/mcp/guards` hay `/mcp/market` (khác bảng liệt kê tổng quan ở ARCHITECTURE §13, vốn là dự kiến
 * ban đầu); mọi số liệu tổng hợp (máy chủ đang bật, tool đã mở, lượt gọi/bị chặn) và mô tả rào chắn khoá cứng ở
 * màn `mcp` đều tính/hiển thị PHÍA CLIENT từ `servers` + `tools` + `calls` đã có, không bịa endpoint.
 */
import type { ApiClient } from './client';

export const MCP_TRANSPORTS = ['stdio', 'http+sse', 'streamable_http'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export type McpToolAccess = 'read' | 'write';
export type McpCallOutcome = 'ok' | 'held_for_approval' | 'blocked' | 'error';

export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  endpoint: string;
  has_auth: boolean;
  is_enabled: boolean;
  health: string;
  note: string | null;
  allow_public_network: boolean;
  tool_count: number;
  exposed_count: number;
}

export interface McpServerCreateBody {
  name: string;
  transport: McpTransport;
  endpoint: string;
  auth_token?: string | null;
  allow_public_network?: boolean;
  note?: string | null;
}

export interface McpServerPatchBody {
  name?: string;
  endpoint?: string;
  auth_token?: string | null;
  allow_public_network?: boolean;
  is_enabled?: boolean;
  note?: string | null;
}

export interface McpTool {
  id: string;
  server_id: string;
  server_name: string;
  name: string;
  access: McpToolAccess;
  is_exposed: boolean;
  schema: Record<string, unknown>;
  grants: string[];
}

export interface McpDiscoveredTool {
  id: string;
  name: string;
  access: McpToolAccess;
  is_exposed: boolean;
  is_new: boolean;
}

export interface McpDiscoverResult {
  tools: McpDiscoveredTool[];
}

export interface McpCall {
  id: string;
  at: string;
  tool_id: string;
  tool_name: string;
  access: McpToolAccess;
  server_name: string;
  agent_key: string;
  args: Record<string, unknown>;
  result_summary: string;
  latency_ms: number | null;
  outcome: McpCallOutcome;
  draft_id: string | null;
}

export interface McpCallPage {
  items: McpCall[];
  next_cursor: string | null;
}

export interface McpCallBody {
  agent_key: string;
  args?: Record<string, unknown>;
}

/** `write`: tạo bản nháp chờ duyệt (`held_for_approval`) hoặc `blocked`. `read` ok: kết quả tool thật. */
export type McpCallResult =
  | { outcome: 'ok'; result: unknown; call: McpCall }
  | { outcome: 'held_for_approval' | 'blocked'; draft: unknown; call: McpCall };

const enc = encodeURIComponent;

/** `GET/POST /mcp/servers`, `/tools*`, `/calls` — không có route nào khác ngoài các route này. */
export function mcpEndpoints(r: ApiClient['request']) {
  return {
    mcp: {
      servers: {
        list: (signal?: AbortSignal) => r<McpServer[]>('/mcp/servers', { signal }),
        create: (body: McpServerCreateBody) => r<McpServer>('/mcp/servers', { method: 'POST', body }),
        update: (id: string, body: McpServerPatchBody) => r<McpServer>(`/mcp/servers/${enc(id)}`, { method: 'PATCH', body }),
        remove: (id: string) => r<void>(`/mcp/servers/${enc(id)}`, { method: 'DELETE' }),
        discover: (id: string) => r<McpDiscoverResult>(`/mcp/servers/${enc(id)}/discover`, { method: 'POST' }),
      },
      tools: {
        list: (serverId?: string, signal?: AbortSignal) =>
          r<McpTool[]>('/mcp/tools', { signal, query: serverId ? { server_id: serverId } : undefined }),
        setAccess: (id: string, access: McpToolAccess) => r<McpTool>(`/mcp/tools/${enc(id)}`, { method: 'PATCH', body: { access } }),
        expose: (id: string, isExposed: boolean) =>
          r<McpTool>(`/mcp/tools/${enc(id)}/expose`, { method: 'PATCH', body: { is_exposed: isExposed } }),
        grant: (id: string, agentKey: string) => r<McpTool>(`/mcp/tools/${enc(id)}/grants`, { method: 'POST', body: { agent_key: agentKey } }),
        ungrant: (id: string, agentKey: string) => r<void>(`/mcp/tools/${enc(id)}/grants/${enc(agentKey)}`, { method: 'DELETE' }),
        call: (id: string, body: McpCallBody) => r<McpCallResult>(`/mcp/tools/${enc(id)}/call`, { method: 'POST', body }),
      },
      calls: (q: { cursor?: string; limit?: number; outcome?: string } = {}, signal?: AbortSignal) =>
        r<McpCallPage>('/mcp/calls', { signal, query: q }),
    },
  };
}
