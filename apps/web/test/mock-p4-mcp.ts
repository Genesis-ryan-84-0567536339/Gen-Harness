/**
 * Mock API giai đoạn 4 · MCP Hub (PLAN 4.3, ARCHITECTURE §10): máy chủ MCP, tool tự khám phá (mặc định
 * `is_exposed=false`), cấp quyền theo agent, gọi tool (khoá cứng #4: máy chủ bật → mở → được cấp → `access`:
 * `write` luôn tạo bản nháp qua `p3Core.hooks.push` rồi dừng; `read` chạy ngay nếu mức tự trị > 1), nhật ký LIVE.
 *
 * Chỉ mô phỏng đúng các route CÓ THẬT ở `apps/api/gh/mcp_api/routes.py` — không có `/mcp/stats`, `/mcp/guards`,
 * `/mcp/market` (những route đó chưa từng được cài, xem ghi chú đầu `packages/contracts/src/p4-mcp.ts`).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AgentIdentity, HubLink, HubReadScopes, McpArgsDigest, McpCall, McpCallOutcome, McpServer, McpTool } from '@gen-harness/contracts';
import type { P2Ctx } from './mock-phase2';
import { AGENT_IDS } from './mock-ids';

/** v0.1.45 (F-57): như `gh.mcp_api.invoke.args_digest` — nhật ký chỉ lưu dấu vết tham số, không nguyên văn. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export function argsDigest(args: Record<string, unknown>): McpArgsDigest {
  const raw = Buffer.from(JSON.stringify(sortKeys(args)));
  return { sha256: createHash('sha256').update(raw).digest('hex'), keys: Object.keys(args).sort().slice(0, 20), bytes: raw.length };
}

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
    { id: 'tool-inv-check', server_id: 'mcp-erp', server_name: 'ERP Genesis', name: 'inventory.check', access: 'read', is_exposed: true, schema: {}, grants: [`agent:${AGENT_IDS.tls}`] },
    { id: 'tool-order-lookup', server_id: 'mcp-erp', server_name: 'ERP Genesis', name: 'order.lookup', access: 'read', is_exposed: true, schema: {}, grants: [] },
    { id: 'tool-order-draft', server_id: 'mcp-erp', server_name: 'ERP Genesis', name: 'order.createDraft', access: 'write', is_exposed: false, schema: {}, grants: [] },
    { id: 'tool-contact-get', server_id: 'mcp-crm', server_name: 'CRM Genesis', name: 'contact.get', access: 'read', is_exposed: true, schema: {}, grants: [`agent:${AGENT_IDS.tls}`] },
    { id: 'tool-deal-upsert', server_id: 'mcp-crm', server_name: 'CRM Genesis', name: 'deal.upsert', access: 'write', is_exposed: true, schema: {}, grants: [`agent:${AGENT_IDS.tls}`] },
    { id: 'tool-event-list', server_id: 'mcp-cal', server_name: 'Lịch & Họp', name: 'event.list', access: 'read', is_exposed: false, schema: {}, grants: [] },
    { id: 'tool-freebusy', server_id: 'mcp-cal', server_name: 'Lịch & Họp', name: 'freebusy.query', access: 'read', is_exposed: false, schema: {}, grants: [] },
  ];
  return { servers, tools };
}

function seedCalls(): McpCall[] {
  return [
    { id: 'call-1', at: ago(6), tool_id: 'tool-inv-check', tool_name: 'inventory.check', access: 'read', server_name: 'ERP Genesis', agent_key: `agent:${AGENT_IDS.tls}`, args: argsDigest({ sku: 'MDF-E1-17' }), result_summary: 'kho Bình Dương → còn 6 container', latency_ms: 412, outcome: 'ok', draft_id: null },
    { id: 'call-2', at: ago(11), tool_id: 'tool-deal-upsert', tool_name: 'deal.upsert', access: 'write', server_name: 'CRM Genesis', agent_key: `agent:${AGENT_IDS.tls}`, args: argsDigest({ code: 'OPP-1815' }), result_summary: 'Chờ duyệt ở Bàn làm việc', latency_ms: null, outcome: 'held_for_approval', draft_id: 'draft-mcp-seed-1' },
    { id: 'call-3', at: ago(18), tool_id: 'tool-order-draft', tool_name: 'order.createDraft', access: 'write', server_name: 'ERP Genesis', agent_key: `agent:${AGENT_IDS.hc}`, args: argsDigest({}), result_summary: 'Bị chặn: tool chưa được Owner mở', latency_ms: null, outcome: 'blocked', draft_id: null },
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
  // v0.1.26 — liên kết Gen-hub (`gh/hub_link/routes.py`). Token chỉ ghi: không bao giờ nằm trong phản hồi.
  let hubLink: HubLink = {
    configured: false, enabled: false, status: 'off', server_id: null, endpoint: null, has_token: false,
    allow_public_network: false, token_expires_at: null, days_left: null, last_ok_at: null, last_error: null, health: null,
  };
  /** v0.1.39: token mock chứa "sai" → Gen-hub từ chối (HUB_TOKEN_REJECTED). Chỉ giữ cờ, không giữ token. */
  let hubTokenBad = false;
  /**
   * v0.1.49 (QD-16): token mock chứa "thieu" → token thiếu quyền đọc lịch + mail (tasks, Drive có) — Kiểm tra vẫn XANH, chỉ báo
   * `read_missing`. Chỉ giữ cờ, không giữ token. Hook e2e `hubSim {scopes:'full'|'missing', breaker?:bool}` đặt thẳng, không qua token.
   */
  let hubScopesMissing = false;
  /** v0.1.49 (F-83): bộ ngắt Gen-hub đang mở (giả lập 3 lỗi liên tiếp) — `GET /hub/link` trả `breaker.open`. */
  let hubBreakerOpen = false;
  const FULL_SCOPES: HubReadScopes = { calendar: true, mail: true, tasks: true, drive: true };
  const MISSING_SCOPES: HubReadScopes = { calendar: false, mail: false, tasks: true, drive: true };
  const SCOPE_LABEL: Record<keyof HubReadScopes, string> = { calendar: 'đọc lịch', mail: 'đọc mail', tasks: 'đọc việc (Google Tasks)', drive: 'tìm tệp Drive' };
  /** `GET /hub/link` luôn kèm `breaker`; `read_scopes` chỉ có sau một lần Kiểm tra xanh (chưa kiểm ⇒ không gửi). */
  const linkOut = (l: HubLink): HubLink => ({ ...l, breaker: { open: hubBreakerOpen, retry_in_s: hubBreakerOpen ? 60 : null } });
  /** v0.1.39 (F-31): như máy chủ — địa chỉ https công khai mà chưa bật "mạng công cộng" thì bị chặn. */
  const publicHttps = (url: string | null) => {
    try {
      const u = new URL(url ?? '');
      const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (u.protocol !== 'https:' || !h.includes('.') || /^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(h)) return false;
      return !/(^|\.)(localhost|local|lan|internal|home\.arpa)$/.test(h);
    } catch {
      return false;
    }
  };
  type HubTestOut = {
    ok: boolean; error: string | null; error_code: string | null; latency_ms: number; exposed_tools: string[]; missing_tools: string[];
    read_scopes?: HubReadScopes; read_missing?: string[]; write_tools?: string[]; link: HubLink;
  };
  /** Một lượt "Kiểm tra" Gen-hub — dùng chung cho `POST /hub/link/test` và `POST /boss-checks/hub/run`. */
  const hubTest = (): HubTestOut => {
    const fail = (code: string, error: string): HubTestOut => {
      hubLink = { ...hubLink, enabled: false, status: 'error', last_error: error, health: 'error' };
      return { ok: false, error, error_code: code, latency_ms: 20, exposed_tools: [], missing_tools: [], link: linkOut(hubLink) };
    };
    if (!hubLink.configured) return fail('HUB_LINK_NOT_CONFIGURED', 'Chưa nhập địa chỉ và token Gen-hub');
    if (publicHttps(hubLink.endpoint) && !hubLink.allow_public_network) return fail('MCP_NETWORK_BLOCKED', "Bật 'Cho phép Gen-hub ở mạng công cộng' ngay trong thẻ này.");
    if (hubTokenBad) return fail('HUB_TOKEN_REJECTED', '401: Token Gen-hub hết hạn hoặc đã bị thu hồi');
    // v0.1.49: thiếu quyền ĐỌC thêm KHÔNG làm ok=false — chỉ trả read_scopes + read_missing; Kiểm tra xanh đóng bộ ngắt.
    const scopes = hubScopesMissing ? MISSING_SCOPES : FULL_SCOPES;
    const readMissing = (Object.keys(scopes) as Array<keyof HubReadScopes>).filter((k) => !scopes[k]).map((k) => SCOPE_LABEL[k]);
    hubBreakerOpen = false;
    hubLink = { ...hubLink, enabled: true, status: 'ok', last_ok_at: new Date().toISOString(), last_error: null, health: 'healthy', read_scopes: { ...scopes } };
    return {
      ok: true, error: null, error_code: null, latency_ms: 240,
      exposed_tools: ['mcp-58450__kho_tom_tat', 'mcp-58450__kho_search', 'mcp-58450__kho_find_by_id'], missing_tools: [],
      read_scopes: { ...scopes }, read_missing: readMissing, write_tools: [], link: linkOut(hubLink),
    };
  };

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
    const item: McpCall = { id: randomUUID(), at: new Date().toISOString(), tool_id: toolId, tool_name: tools.find((t) => t.id === toolId)?.name ?? '?', access: tools.find((t) => t.id === toolId)?.access ?? 'read', server_name: tools.find((t) => t.id === toolId)?.server_name ?? '?', agent_key: agentKey, args: argsDigest(args), result_summary: summary, latency_ms: latencyMs, outcome, draft_id: draftId };
    calls = [item, ...calls];
    opts.emit('mcp.call', item);
    return item;
  }

  function handleHub(ctx: P2Ctx): boolean {
    const { method: m, path: p, body, reply, problem } = ctx;
    if (p === '/hub/link' && m === 'GET') {
      if (!has(ctx, 'system.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      // v0.1.27: lỗi thô chỉ Owner thấy (như `link_out(owner=…)` ở API).
      if (ctx.role !== 'owner' && hubLink.last_error) return reply(200, linkOut({ ...hubLink, last_error: 'Gen-hub đang lỗi — Owner xem chi tiết ở thẻ Gen-hub' }));
      return reply(200, linkOut(hubLink));
    }
    if ((p === '/hub/link' && m === 'PATCH') || (p === '/hub/link/test' && m === 'POST')) {
      if (ctx.role !== 'owner') return problem(403, 'FORBIDDEN', 'Vai trò của bạn không có quyền thao tác này');
      if (!pin(ctx, 'hub.link')) return true;
      if (m === 'PATCH') {
        const b = body as { endpoint?: string; token?: string; token_expires_at?: string | null; allow_public_network?: boolean; enabled?: boolean };
        if (!hubLink.configured && (!b.endpoint || !b.token)) return problem(422, 'VALIDATION', 'Dữ liệu chưa hợp lệ', { errors: { endpoint: 'Cần địa chỉ Gen-hub và token cho lần nối đầu' } });
        const relink = (b.endpoint !== undefined && b.endpoint !== hubLink.endpoint) || !!b.token;
        if (b.token) {
          hubTokenBad = b.token.includes('sai');
          hubScopesMissing = b.token.includes('thieu');
        }
        hubLink = {
          ...hubLink, configured: true, server_id: hubLink.server_id ?? 'mcp-genhub', endpoint: b.endpoint ?? hubLink.endpoint,
          has_token: hubLink.has_token || !!b.token, allow_public_network: b.allow_public_network ?? hubLink.allow_public_network,
          token_expires_at: 'token_expires_at' in b ? b.token_expires_at ?? null : hubLink.token_expires_at,
        };
        if (relink || b.enabled === false) hubLink = { ...hubLink, enabled: false, status: 'off' };
        // Đổi địa chỉ/token ⇒ quyền đọc đã kiểm không còn đúng cho tới khi Kiểm tra lại.
        if (relink) {
          const { read_scopes: _rs, ...rest } = hubLink;
          void _rs;
          hubLink = rest;
        }
        return reply(200, linkOut(hubLink));
      }
      if (!hubLink.configured) return problem(409, 'HUB_LINK_NOT_CONFIGURED', 'Chưa nhập địa chỉ và token Gen-hub');
      return reply(200, hubTest());
    }
    return false;
  }

  /** Hook e2e `POST /api/v1/__mock/p3/mcp/hubSim {scopes?:'full'|'missing', breaker?:bool}` (v0.1.49) — không qua token. */
  const hubSim = (b: unknown) => {
    const body = (b ?? {}) as { scopes?: unknown; breaker?: unknown };
    if (body.scopes === 'missing') hubScopesMissing = true;
    if (body.scopes === 'full') hubScopesMissing = false;
    if (typeof body.breaker === 'boolean') hubBreakerOpen = body.breaker;
    return { scopes: hubScopesMissing ? 'missing' : 'full', breaker: hubBreakerOpen };
  };

  function handle(ctx: P2Ctx): boolean {
    const { method: m, path: p, url, body, reply, problem } = ctx;
    if (p.startsWith('/hub/')) return handleHub(ctx);
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
        opts.emit('mcp.server_health', { server_id: server.id, health: server.health });
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
        // v0.1.45 (F-20): ghi → đọc là bỏ qua duyệt ⇒ cần phiên PIN `mcp.expose` (đọc → ghi thì không).
        if (tool.access === 'write' && access === 'read' && !pin(ctx, 'mcp.expose')) return true;
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
      /** v0.1.39 — cho `mock-boss-checks.ts` và `/setup/follow-up` (việc 14). */
      hubLink: () => hubLink,
      hubTest,
      hubSim,
    } as Record<string, (...args: never[]) => unknown>,
    dispose: () => {},
  };
}
