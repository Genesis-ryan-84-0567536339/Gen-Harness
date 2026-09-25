/**
 * Hợp đồng API giai đoạn 4 · API & Model (PLAN 4.2, `apps/api/gh/agents_api/routes.py` +
 * `apps/api/gh/system_api/routes.py`).
 *
 * Provider/khoá/model/CLI (`/providers`, `/providers/{id}/keys`, `/providers/{id}/models`,
 * `/providers/{id}/test`, `/providers/credentials`, `/cli/*`) đã có hợp đồng từ giai đoạn 2 ở `endpoints.ts` —
 * KHÔNG lặp lại. Module này chỉ thêm phần mới của 4.2: gán model theo agent/mục đích (`agent.bindings`) và quy
 * tắc chuyển hướng tĩnh (`/failover-rules`). `PATCH /providers/chain` (kéo-thả) được thêm thẳng vào namespace
 * `providers` sẵn có ở `endpoints.ts`, cùng chỗ với `providers.update`.
 */
import type { ApiClient } from './client';
import type { AgentBinding } from './p4-agents';

export interface AgentBindingSlot {
  agent_key: string;
  label: string;
  binding: AgentBinding | null;
}

export interface BindableModel {
  id: string;
  model_name: string;
  provider_name: string;
  enabled: boolean;
}

export interface BindingsPage {
  items: AgentBindingSlot[];
  models: BindableModel[];
}

export interface BindingSetBody {
  model_id: string;
  temperature?: number;
  context_tokens?: number;
  rule_codes?: string[];
}

export interface FailoverRule {
  key: string;
  value: string;
}

const enc = encodeURIComponent;

/** `agent.bindings` (`/agents/bindings*`) + `/failover-rules` (chỉ đọc, ARCHITECTURE §11). */
export function agentModelEndpoints(r: ApiClient['request']) {
  return {
    bindings: {
      list: (signal?: AbortSignal) => r<BindingsPage>('/agents/bindings', { signal }),
      set: (agentKey: string, body: BindingSetBody) =>
        r<{ agent_key: string; label: string; binding: AgentBinding }>(`/agents/bindings/${enc(agentKey)}`, { method: 'PUT', body }),
      remove: (agentKey: string) => r<void>(`/agents/bindings/${enc(agentKey)}`, { method: 'DELETE' }),
    },
    failoverRules: (signal?: AbortSignal) => r<FailoverRule[]>('/failover-rules', { signal }),
  };
}
