/**
 * Mock API giai đoạn 4 · API & Model (PLAN 4.2): gán model theo agent/mục đích (`agent.bindings`), quy tắc
 * chuyển hướng tĩnh (`GET /failover-rules`), kéo-thả chuỗi ưu tiên (`PATCH /providers/chain`), và thêm/xoá
 * khoá (`POST /providers/{id}/keys`, `DELETE /providers/{id}/keys/{kid}` — `mock-phase2.ts` chưa có hai
 * đường này dù đã có hợp đồng từ giai đoạn 2; tất cả đọc/ghi thẳng lên mảng `providers` dùng chung với
 * `mock-phase2.ts` qua `hooks.providers()`, KHÔNG copy, để `GET /providers` sau đó thấy đúng thay đổi).
 *
 * Provider CRUD/model/CLI khác đã có đủ ở `mock-phase2.ts` — không lặp lại ở đây.
 */
import { randomUUID } from 'node:crypto';
import type { AgentIdentity, BindableModel, FailoverRule } from '@gen-harness/contracts';
import type { P2Ctx } from './mock-phase2';

interface MockProviderKey {
  id: string;
  label: string;
  last4: string;
  enabled: boolean;
  cooldown_until: string | null;
  quota_left_pct: number | null;
}
interface MockProviderModel {
  id: string;
  model_name: string;
  daily_quota: number | null;
  used_today: number;
}
interface MockProvider {
  id: string;
  kind: string;
  name: string;
  failover_rank: number;
  enabled: boolean;
  auth_state: string;
  keys: MockProviderKey[];
  models: MockProviderModel[];
}

export interface P4ApiOptions {
  fresh: boolean;
  emit: (type: string, data: unknown) => void;
  /** `mock-p4-agents.ts` (đăng ký trước cụm này trong `phase3` — xem `mock-api.ts`). */
  getAgents: () => AgentIdentity[];
  /** `mock-phase2.ts` hooks.providers() — mảng dùng chung, KHÔNG copy (chain cần sửa tại chỗ). */
  getProviders: () => MockProvider[];
}

/** ARCHITECTURE §11 — cố định, chỉ đọc. */
const FAILOVER_RULES: FailoverRule[] = [
  { key: 'hết hạn mức', value: 'chuyển xuống nhà cung cấp kế tiếp trong chuỗi' },
  { key: 'ngắt mạch', value: 'giữ nguyên hội thoại, thử lại sau 60 giây' },
  { key: 'hết chuỗi', value: 'xếp hàng và báo Sếp qua hàng đợi cần xử lý' },
  { key: 'ngưỡng cảnh báo', value: 'còn dưới 20% hạn mức trên bất kỳ model nào' },
];

/** `gh.agents_api.routes.CORE_AGENT_KEYS`. */
const CORE_AGENT_KEYS: Record<string, string> = {
  'core.refinery': 'Sàng lọc & suy luận chính',
  'core.reply': 'Trả lời nhanh trong nhóm',
  'core.intent': 'Tách ý định / phân loại',
  'core.scoring': 'Chấm điểm suy luận dài',
  'core.indexing': 'Đánh chỉ mục / embedding',
};

interface BindingState {
  model_id: string;
  model_name: string;
  provider_name: string;
  temperature: number;
  context_tokens: number;
  rule_codes: string[];
}

export function createMock(opts: P4ApiOptions) {
  const bindings = new Map<string, BindingState>(
    opts.fresh
      ? []
      : [
          ['core.refinery', { model_id: 'md-antigravity-pro', model_name: 'gemini-2.5-pro', provider_name: 'Antigravity Brain', temperature: 0.2, context_tokens: 64_000, rule_codes: ['R-01', 'R-02', 'R-03', 'R-04', 'R-05', 'R-06'] }],
        ],
  );
  const has = (ctx: P2Ctx, perm: string) => !!ctx.perms[perm] && ctx.perms[perm] !== 'none';

  function findModel(modelId: string): { model_name: string; provider_name: string } | null {
    for (const p of opts.getProviders()) {
      const m = p.models.find((x) => x.id === modelId);
      if (m) return { model_name: m.model_name, provider_name: p.name };
    }
    return null;
  }

  function bindableModels(): BindableModel[] {
    const out: BindableModel[] = [];
    for (const p of opts.getProviders()) {
      for (const m of p.models) out.push({ id: m.id, model_name: m.model_name, provider_name: p.name, enabled: p.enabled });
    }
    return out;
  }

  function keysAndLabels(): Array<[string, string]> {
    const agents = opts.getAgents();
    return [...Object.entries(CORE_AGENT_KEYS), ...agents.map((a): [string, string] => [`agent:${a.id}`, a.name])];
  }

  function labelOf(agentKey: string): string | null {
    if (CORE_AGENT_KEYS[agentKey]) return CORE_AGENT_KEYS[agentKey];
    if (agentKey.startsWith('agent:')) return opts.getAgents().find((a) => a.id === agentKey.slice('agent:'.length))?.name ?? null;
    return null;
  }

  function stripSecret(p: MockProvider) {
    const { _secret: _s, ...rest } = p as MockProvider & { _secret?: string };
    return rest;
  }

  function handle(ctx: P2Ctx): boolean {
    const { method: m, path: p, reply, problem, body } = ctx;
    const seg = p.split('/').filter(Boolean);

    if (p === '/failover-rules' && m === 'GET') {
      if (!has(ctx, 'system.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      return reply(200, FAILOVER_RULES);
    }

    if (seg[0] === 'providers' && seg[2] === 'keys') {
      if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      const pv = opts.getProviders().find((x) => x.id === seg[1]);
      if (!pv) return problem(404, 'NOT_FOUND', 'Nhà cung cấp không tồn tại');
      if (seg.length === 3 && m === 'POST') {
        if (pv.kind === 'antigravity_cli') return problem(409, 'CLI_NO_KEYS', 'Antigravity CLI dùng phiên đăng nhập, không dùng khoá API');
        const secret = String((body as { secret?: string }).secret ?? '').trim();
        if (secret.length < 8) return problem(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors: { secret: 'Khoá API không hợp lệ' } });
        const prefix = pv.kind === 'gemini' ? 'GEM' : pv.kind === 'deepseek' ? 'DS' : 'API';
        pv.keys.push({ id: randomUUID(), label: `${prefix}-KEY-0${pv.keys.length + 1}`, last4: secret.slice(-4), enabled: true, cooldown_until: null, quota_left_pct: null });
        return reply(201, stripSecret(pv));
      }
      if (seg.length === 4 && m === 'DELETE') {
        const i = pv.keys.findIndex((k) => k.id === seg[3]);
        if (i < 0) return problem(404, 'NOT_FOUND', 'Khoá không tồn tại');
        pv.keys.splice(i, 1);
        return reply(204);
      }
    }

    if (p === '/providers/chain' && m === 'PATCH') {
      if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      const ids = Array.isArray((body as { provider_ids?: unknown }).provider_ids) ? ((body as { provider_ids: string[] }).provider_ids) : [];
      const uniqueIds = [...new Set(ids)];
      const providers = opts.getProviders();
      const have = new Set(providers.map((x) => x.id));
      const want = new Set(uniqueIds);
      if (uniqueIds.length !== have.size || [...have].some((id) => !want.has(id))) {
        return problem(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors: { provider_ids: 'Cần đúng và đủ danh sách nhà cung cấp hiện có, không thiếu không thừa' } });
      }
      uniqueIds.forEach((id, i) => {
        const pv = providers.find((x) => x.id === id);
        if (pv) pv.failover_rank = i + 1;
      });
      return reply(200, [...providers].sort((a, b) => a.failover_rank - b.failover_rank).map(stripSecret));
    }

    if (seg[0] !== 'agents' || seg[1] !== 'bindings') return false;

    if (seg.length === 2 && m === 'GET') {
      if (!has(ctx, 'system.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      const items = keysAndLabels().map(([agent_key, label]) => ({ agent_key, label, binding: bindings.get(agent_key) ?? null }));
      return reply(200, { items, models: bindableModels() });
    }

    const agentKey = decodeURIComponent(seg[2] ?? '');

    if (seg.length === 3 && m === 'PUT') {
      if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      const label = labelOf(agentKey);
      if (label === null) return problem(404, 'NOT_FOUND', 'Agent không tồn tại');
      const b = body as Record<string, unknown>;
      const modelId = String(b.model_id ?? '');
      const found = findModel(modelId);
      if (!found) return problem(404, 'NOT_FOUND', 'Model không tồn tại');
      const binding: BindingState = {
        model_id: modelId, model_name: found.model_name, provider_name: found.provider_name,
        temperature: typeof b.temperature === 'number' ? b.temperature : 0.3,
        context_tokens: typeof b.context_tokens === 'number' ? b.context_tokens : 8000,
        rule_codes: Array.isArray(b.rule_codes) ? (b.rule_codes as string[]) : [],
      };
      bindings.set(agentKey, binding);
      return reply(200, { agent_key: agentKey, label, binding });
    }

    if (seg.length === 3 && m === 'DELETE') {
      if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      if (!bindings.has(agentKey)) return problem(404, 'NOT_FOUND', 'Gán model không tồn tại');
      bindings.delete(agentKey);
      return reply(204);
    }

    return false;
  }

  return {
    handle,
    hooks: {} as Record<string, (...args: never[]) => unknown>,
    dispose: () => {},
  };
}
