/**
 * Mock API giai đoạn 4 · MCP Hub (PLAN 4.3, ARCHITECTURE §10): máy chủ MCP, tool tự khám phá (mặc định
 * `is_exposed=false`), cấp quyền theo agent, gọi tool (khoá cứng #4: máy chủ bật → mở → được cấp → `access`:
 * `write` luôn tạo bản nháp qua `p3Core.hooks.push` rồi dừng; `read` chạy ngay nếu mức tự trị > 1), nhật ký LIVE.
 *
 * Chỉ mô phỏng đúng các route CÓ THẬT ở `apps/api/gh/mcp_api/routes.py` — không có `/mcp/stats`, `/mcp/guards`,
 * `/mcp/market` (những route đó chưa từng được cài, xem ghi chú đầu `packages/contracts/src/p4-mcp.ts`).
 */
import { randomUUID } from 'node:crypto';
import type { AgentIdentity, McpCall, McpCallOutcome, McpServer, McpTool } from '@gen-harness/contracts';
import type { P2Ctx } from './mock-phase2';

export interface P4McpOptions {
  fresh: boolean;
  emit: (type: string, data: unknown) => void;
  getAgents: () => AgentIdentity[];
  /** `p3Core.hooks.push` — tạo bản nháp `kind='mcp_write'` dùng chung cơ chế `create_draft`. */
  pushDraft: (d: Record<string, unknown>) => unknown;
}

interface MockServer extends Omit<McpServer, 'has_auth' | 'tool_count' | 'exposed_count'> {
  _authToken: string | null;
}
type MockTool = McpTool;

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function seedServers(): { servers: MockServer[]; tools: MockTool[] } {
  const servers: MockServer[] = [
    { id: 'mcp-erp', name: 'ERP Genesis', transport: 'stdio', endpoint: 'mcp://localhost:7011 · genesis-erp-server v2.4', is_enabled: true, health: 'healthy', note: 'Chỉ đọc tồn kho và đơn hàng. Ghi đơn nháp phải qua bước Sếp duyệt.', allow_public_network: false, _authToken: 'erp-token-xyz' },
    { id: 'mcp-crm', name: 'CRM Genesis', transport: 'http+sse', endpoint: 'https://crm.genesis.internal/mcp · v1.9', is_enabled: true, health: 'healthy', note: 'Hai chiều: agent đọc hồ sơ và ghi lại pipeline sau khi Sếp duyệt.', allow_public_network: false, _authToken: 'crm-token-abc' },
    { id: 'mcp-cal', name: 'Lịch & Họp', transport: 'http+sse', endpoint: 'https://cal.genesis.internal/mcp · v1.2', is_enabled: true, health: 'healthy', note: 'Agent được tự đặt lịch nội bộ, lịch với khách ngoài phải chờ duyệt.', allow_public_network: false, _authToken: null },
    { id: 'mcp-hrm', name: 'HRM', transport: 'http+sse', endpoint: 'https://hrm.genesis.internal/mcp · v0.9', is_enabled: true, health: 'error', note: 'Dữ liệu nhân sự bị khoá ở mức Owner — không mở cho agent nào.', allow_public_network: false, _authToken: 'hrm-token-expired' },
  ];
  const tools: MockTool[] = [
    { id: 'tool-inv-check', server_id: 'mcp-erp', server_name: 'ERP Genesis', name: 'inventory.check', access: 'read', is_exposed: true, schema: {}, grants: ['agent:agent-tls'] },
    { id: 'tool-order-lookup', server_id: 'mcp-erp', server_name: 'ERP Genesis', name: 'order.lookup', access: 'read', is_exposed: true, schema: {}, grants: [] },
    { id: 'tool-order-draft', server_id: 'mcp-erp', server_name: 'ERP Genesis', name: 'order.createDraft', access: 'write', is_exposed: false, schema: {}, grants: [] },
    { id: 'tool-contact-get', server_id: 'mcp-crm', server_name: 'CRM Genesis', name: 'contact.get', access: 'read', is_exposed: true, schema: {}, grants: ['agent:agent-tls'] },
    { id: 'tool-deal-upsert', server_id: 'mcp-crm', server_name: 'CRM Genesis', name: 'deal.upsert', access: 'write', is_exposed: true, schema: {}, grants: ['agent:agent-tls'] },
    { id: 'tool-event-list', server_id: 'mcp-cal', server_name: 'Lịch & Họp', name: 'event.list', access: 'read', is_exposed: false, schema: {}, grants: [] },
    { id: 'tool-freebusy', server_id: 'mcp-cal', server_name: 'Lịch & Họp', name: 'freebusy.query', access: 'read', is_exposed: false, schema: {}, grants: [] },
  ];
  return { servers, tools };
}

function seedCalls(): McpCall[] {
  return [
    { id: 'call-1', at: ago(6), tool_id: 'tool-inv-check', tool_name: 'inventory.check', access: 'read', server_name: 'ERP Genesis', agent_key: 'agent:agent-tls', args: { sku: 'MDF-E1-17' }, result_summary: 'kho Bình Dương → còn 6 container', latency_ms: 412, outcome: 'ok', draft_id: null },
    { id: 'call-2', at: ago(11), tool_id: 'tool-deal-upsert', tool_name: 'deal.upsert', access: 'write', server_name: 'CRM Genesis', agent_key: 'agent:agent-tls', args: { code: 'OPP-1815' }, result_summary: 'Chờ duyệt ở Bàn làm việc', latency_ms: null, outcome: 'held_for_approval', draft_id: 'draft-mcp-seed-1' },
    { id: 'call-3', at: ago(18), tool_id: 'tool-order-draft', tool_name: 'order.createDraft', access: 'write', server_name: 'ERP Genesis', agent_key: 'agent:agent-hc', args: {}, result_summary: 'Bị chặn: tool chưa được Owner mở', latency_ms: null, outcome: 'blocked', draft_id: null },
  ];
}

/** Nguồn tool "mới xuất hiện" mà `discover` tìm ra lần khám phá kế tiếp — mô phỏng máy chủ khai báo thêm khả năng. */
const HIDDEN_NEW_TOOL: Record<string, { name: string; access: 'read' | 'write' }> = {
  'mcp-erp': { name: 'price.getList', access: 'read' },
};

export function createMock(opts: P4McpOptions) {
  const seed = opts.fresh ? { servers: [], tools: [] } : seedServers();
  let servers: MockServer[] = seed.servers;
  let tools: MockTool[] = seed.tools;
  let calls: McpCall[] = opts.fresh ? [] : seedCalls();
  const discovered = new Set<string>(); // server_id đã khám phá lần nào chưa (để lộ HIDDEN_NEW_TOOL đúng một lần)

  const has = (ctx: P2Ctx, perm: string) => !!ctx.perms[perm] && ctx.perms[perm] !== 'none';
  const pin = (ctx: P2Ctx, operation: string) => {
    if (!ctx.needPin()) return true;
    ctx.problem(423, 'PIN_REQUIRED', 'Thao tác này cần nhập mã PIN', { detail: { operation } });
    return false;
  };

  function serverOut(s: MockServer): McpServer {
    const st = tools.filter((t) => t.server_id === s.id);
    const { _authToken, ...rest } = s;
    return { ...rest, has_auth: _authToken != null, tool_count: st.length, exposed_count: st.filter((t) => t.is_exposed).length };
  }
  function toolOut(t: MockTool): McpTool {
    return t;
  }
  function agentLevel(agentKey: string): number {
    if (agentKey.startsWith('core.')) return 4;
    const a = opts.getAgents().find((x) => `agent:${x.id}` === agentKey);
    return a?.autonomy_level ?? 0;
  }

  function logCall(toolId: string, agentKey: string, args: Record<string, unknown>, outcome: McpCallOutcome, summary: string, latencyMs: number | null, draftId: string | null = null): McpCall {
    const item: McpCall = { id: randomUUID(), at: new Date().toISOString(), tool_id: toolId, tool_name: tools.find((t) => t.id === toolId)?.name ?? '?', access: tools.find((t) => t.id === toolId)?.access ?? 'read', server_name: tools.find((t) => t.id === toolId)?.server_name ?? '?', agent_key: agentKey, args, result_summary: summary, latency_ms: latencyMs, outcome, draft_id: draftId };
    calls = [item, ...calls];
    opts.emit('mcp.call', item);
    return item;
  }

  function handle(ctx: P2Ctx): boolean {
    const { method: m, path: p, url, body, reply, problem } = ctx;
    if (!p.startsWith('/mcp/')) return false;
    const seg = p.split('/').filter(Boolean); // ['mcp', ...]

    if (seg[1] === 'servers') {
      if (seg.length === 2 && m === 'GET') {
        if (!has(ctx, 'system.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        return reply(200, servers.map(serverOut));
      }
      if (seg.length === 2 && m === 'POST') {
        if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        const b = body as Record<string, unknown>;
        const name = String(b.name ?? '').trim();
        const transport = String(b.transport ?? '');
        const endpoint = String(b.endpoint ?? '').trim();
        const errors: Record<string, string> = {};
        if (!name) errors.name = 'Không được để trống';
        if (!['stdio', 'http+sse', 'streamable_http'].includes(transport)) errors.transport = 'Chỉ nhận stdio, http+sse, streamable_http';
        if (!endpoint) errors.endpoint = 'Không được để trống';
        if (Object.keys(errors).length) return problem(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors });
        const s: MockServer = {
          id: randomUUID(), name, transport: transport as MockServer['transport'], endpoint,
          is_enabled: true, health: 'unknown', note: (b.note as string | null) ?? null,
          allow_public_network: b.allow_public_network === true, _authToken: (b.auth_token as string | null) || null,
        };
        servers = [...servers, s];
        return reply(201, serverOut(s));
      }
      const server = servers.find((s) => s.id === seg[2]);
      if (seg.length === 3 && m === 'PATCH') {
        if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        if (!server) return problem(404, 'NOT_FOUND', 'Máy chủ MCP không tồn tại');
        const b = body as Record<string, unknown>;
        if (typeof b.name === 'string' && b.name.trim()) server.name = b.name.trim();
        if (typeof b.endpoint === 'string' && b.endpoint.trim()) server.endpoint = b.endpoint.trim();
        if ('note' in b) server.note = (b.note as string | null) ?? null;
        if (typeof b.allow_public_network === 'boolean') server.allow_public_network = b.allow_public_network;
        if (typeof b.is_enabled === 'boolean') server.is_enabled = b.is_enabled;
        if (typeof b.auth_token === 'string') server._authToken = b.auth_token || null;
        return reply(200, serverOut(server));
      }
      if (seg.length === 3 && m === 'DELETE') {
        if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        if (!server) return problem(404, 'NOT_FOUND', 'Máy chủ MCP không tồn tại');
        servers = servers.filter((s) => s.id !== server.id);
        tools = tools.filter((t) => t.server_id !== server.id);
        return reply(204);
      }
      if (seg[3] === 'discover' && seg.length === 4 && m === 'POST') {
        if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        if (!server) return problem(404, 'NOT_FOUND', 'Máy chủ MCP không tồn tại');
        if (!server.is_enabled) return problem(409, 'MCP_SERVER_DISABLED', 'Máy chủ đang tắt');
        const found: { id: string; name: string; access: string; is_exposed: boolean; is_new: boolean }[] = [];
        for (const t of tools.filter((x) => x.server_id === server.id)) found.push({ id: t.id, name: t.name, access: t.access, is_exposed: t.is_exposed, is_new: false });
        const hidden = HIDDEN_NEW_TOOL[server.id];
        if (hidden && !discovered.has(server.id)) {
          const nt: MockTool = { id: randomUUID(), server_id: server.id, server_name: server.name, name: hidden.name, access: hidden.access, is_exposed: false, schema: {}, grants: [] };
          tools = [...tools, nt];
          found.push({ id: nt.id, name: nt.name, access: nt.access, is_exposed: false, is_new: true });
        }
        discovered.add(server.id);
        server.health = 'healthy';
        return reply(200, { tools: found });
      }
    }

    if (seg[1] === 'tools') {
      if (seg.length === 2 && m === 'GET') {
        if (!has(ctx, 'system.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        const serverId = url.searchParams.get('server_id');
        return reply(200, tools.filter((t) => !serverId || t.server_id === serverId).map(toolOut));
      }
      const tool = tools.find((t) => t.id === seg[2]);

      if (seg.length === 3 && m === 'PATCH') {
        if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        if (!tool) return problem(404, 'NOT_FOUND', 'Tool MCP không tồn tại');
        const access = String((body as { access?: string }).access ?? '');
        if (!['read', 'write'].includes(access)) return problem(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors: { access: 'Chỉ nhận read, write' } });
        tool.access = access as MockTool['access'];
        return reply(200, toolOut(tool));
      }
      if (seg[3] === 'expose' && seg.length === 4 && m === 'PATCH') {
        if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        if (!pin(ctx, 'mcp.expose')) return true;
        if (!tool) return problem(404, 'NOT_FOUND', 'Tool MCP không tồn tại');
        tool.is_exposed = (body as { is_exposed?: boolean }).is_exposed === true;
        return reply(200, toolOut(tool));
      }
      if (seg[3] === 'grants' && seg.length === 4 && m === 'POST') {
        if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        if (!tool) return problem(404, 'NOT_FOUND', 'Tool MCP không tồn tại');
        const agentKey = String((body as { agent_key?: string }).agent_key ?? '');
        if (!agentKey) return problem(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors: { agent_key: 'Không được để trống' } });
        if (!tool.grants.includes(agentKey)) tool.grants = [...tool.grants, agentKey];
        return reply(201, toolOut(tool));
      }
      if (seg[3] === 'grants' && seg.length === 5 && m === 'DELETE') {
        if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        if (!tool) return problem(404, 'NOT_FOUND', 'Tool MCP không tồn tại');
        tool.grants = tool.grants.filter((a) => a !== decodeURIComponent(seg[4]));
        return reply(204);
      }
      if (seg[3] === 'call' && seg.length === 4 && m === 'POST') {
        if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        if (!tool) return problem(404, 'NOT_FOUND', 'Tool MCP không tồn tại');
        const b = body as { agent_key?: string; args?: Record<string, unknown> };
        const agentKey = String(b.agent_key ?? '');
        const args = b.args ?? {};
        if (!agentKey) return problem(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors: { agent_key: 'Không được để trống' } });
        const server = servers.find((s) => s.id === tool.server_id)!;
        const blocked = (code: string, msg: string) => {
          const item = logCall(tool.id, agentKey, args, 'blocked', msg, null);
          return problem(403, code, 'Bị chặn', { detail: msg, call: item });
        };
        if (!server.is_enabled) return blocked('MCP_SERVER_DISABLED', 'Bị chặn: máy chủ MCP đang tắt');
        if (!tool.is_exposed) return blocked('MCP_TOOL_NOT_EXPOSED', 'Bị chặn: tool chưa được Owner mở');
        if (!tool.grants.includes(agentKey)) return blocked('MCP_TOOL_NOT_GRANTED', 'Bị chặn: agent chưa được cấp tool này');
        if (tool.access === 'write') {
          const now = new Date().toISOString();
          const draftId = `draft-mcp-${randomUUID()}`;
          const draft = opts.pushDraft({
            id: draftId, code: `ACT-MCP-${calls.length + 1}`, kind: 'mcp_write', kind_label: 'Gọi tool MCP',
            title: `Gọi tool ${tool.name}`, agent: agentKey.startsWith('agent:') ? { id: agentKey.slice(6), name: opts.getAgents().find((a) => a.id === agentKey.slice(6))?.name ?? agentKey } : null,
            created_by: null, created_at: now, status: 'pending', hold_reason: 'ghi ra ngoài qua MCP', subject: null,
            paragraphs: [`Gọi tool MCP ghi '${tool.name}' trên máy chủ '${server.name}' với tham số ${JSON.stringify(args)}`],
            text: `Gọi tool MCP ghi '${tool.name}' trên máy chủ '${server.name}' với tham số ${JSON.stringify(args)}`,
            lang: 'vi', target: null, amount_vnd: null, autonomy_level: agentLevel(agentKey),
            flags: { writes_external: true, personnel_related: false, over_threshold: false },
            approve_label: 'Duyệt và thực hiện', sources: [{ label: server.name, ref: { type: 'mcp_server', id: server.id } }],
            context: [], side_actions: [], decision: null, send_result: null, versions: [],
          });
          const item = logCall(tool.id, agentKey, args, 'held_for_approval', 'Chờ duyệt ở Bàn làm việc', null, draftId);
          return reply(200, { outcome: 'held_for_approval', draft, call: item });
        }
        const level = agentLevel(agentKey);
        if (level <= 1) return blocked('MCP_AUTONOMY_TOO_LOW', `Bị chặn: mức tự trị hiện tại (${level}) không cho gọi tool`);
        const result = { ok: true, echo: args, note: `Kết quả giả lập từ ${tool.name}` };
        const item = logCall(tool.id, agentKey, args, 'ok', JSON.stringify(result), 180 + Math.floor(Math.random() * 400));
        return reply(200, { outcome: 'ok', result, call: item });
      }
    }

    if (p === '/mcp/calls' && m === 'GET') {
      if (!has(ctx, 'system.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      const outcome = url.searchParams.get('outcome');
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const rows = calls.filter((c) => !outcome || c.outcome === outcome);
      return reply(200, { items: rows.slice(0, limit), next_cursor: null });
    }

    return false;
  }

  return {
    handle,
    hooks: {
      servers: () => servers,
      tools: () => tools,
    } as Record<string, (...args: never[]) => unknown>,
    dispose: () => {},
  };
}
