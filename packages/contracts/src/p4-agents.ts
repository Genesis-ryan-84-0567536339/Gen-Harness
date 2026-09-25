/**
 * Hợp đồng API giai đoạn 4 · Danh tính Agent (PLAN 4.1, `apps/api/gh/agents_api/routes.py`).
 *
 * "Agent đã nói gì, nhân danh gì" dùng `agentDecisions` (đã có ở `p3-core.ts`, `GET /agents/decisions`) —
 * KHÔNG lặp lại ở đây.
 */
import type { ApiClient } from './client';

/** Mẫu có sẵn (spec E13) — gợi ý prefill khi tạo mới, không phải bản sắc hệ thống, không mặc định bắt buộc. */
export interface AgentTemplate {
  code: string;
  name: string;
  role_desc: string;
  voice: string;
  speak_when: string;
  forbidden: string[];
  default_enabled: boolean;
}

export interface AgentChannelScope {
  channel_id: string;
  channel_type: string;
  group_id: string | null;
  group_name: string | null;
}

export interface AgentChannelScopeIn {
  channel_id: string;
  group_id?: string | null;
}

export interface AgentBinding {
  model_id: string;
  model_name: string;
  provider_name: string;
  temperature: number;
  context_tokens: number;
  rule_codes: string[];
}

export interface AgentIdentity {
  id: string;
  name: string;
  role_desc: string;
  template: string | null;
  addressing: Record<string, unknown>;
  voice: string;
  speak_when: string;
  forbidden: string[];
  autonomy_level: number;
  is_enabled: boolean;
  limits: Record<string, number>;
  created_at: string;
  updated_at: string;
  channel_scopes: AgentChannelScope[];
  binding: AgentBinding | null;
}

export interface AgentCreateBody {
  name: string;
  role_desc: string;
  voice: string;
  speak_when: string;
  template?: string | null;
  addressing?: Record<string, unknown>;
  forbidden?: string[];
  autonomy_level?: number;
  limits?: Record<string, number>;
  is_enabled?: boolean;
  channel_scopes?: AgentChannelScopeIn[];
}

export type AgentPatchBody = Partial<Omit<AgentCreateBody, 'channel_scopes'>> & {
  channel_scopes?: AgentChannelScopeIn[] | null;
};

export interface AgentCloneBody {
  name: string;
  copy_channel_scopes?: boolean;
}

const enc = encodeURIComponent;

/** `GET/POST /agents`, `/agents/{id}`, `/{id}/clone`, `/{id}/disable`, `/agents/templates`. */
export function agentsEndpoints(r: ApiClient['request']) {
  return {
    agents: {
      templates: (signal?: AbortSignal) => r<AgentTemplate[]>('/agents/templates', { signal }),
      list: (signal?: AbortSignal) => r<AgentIdentity[]>('/agents', { signal }),
      get: (id: string, signal?: AbortSignal) => r<AgentIdentity>(`/agents/${enc(id)}`, { signal }),
      create: (body: AgentCreateBody) => r<AgentIdentity>('/agents', { method: 'POST', body }),
      update: (id: string, body: AgentPatchBody) => r<AgentIdentity>(`/agents/${enc(id)}`, { method: 'PATCH', body }),
      clone: (id: string, body: AgentCloneBody) => r<AgentIdentity>(`/agents/${enc(id)}/clone`, { method: 'POST', body }),
      setEnabled: (id: string, enabled: boolean) =>
        r<AgentIdentity>(`/agents/${enc(id)}/disable`, { method: 'PATCH', body: { enabled } }),
    },
  };
}
