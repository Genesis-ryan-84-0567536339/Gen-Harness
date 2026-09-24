import type { ApiClient } from './client';
import { coreEndpoints } from './p3-core';
import { queueEndpoints } from './p3-queue';
import { relationsEndpoints } from './p3-relations';
import { graphEndpoints } from './p3-graph';
import { marketEndpoints } from './p3-market';
import { peopleEndpoints } from './p3-people';
import type {
  AuditPage,
  AuditVerify,
  HeaderStatus,
  Health,
  Me,
  NavDomain,
  Plugin,
  Ready,
  SetupState,
  SetupStep1Body,
  SetupStep2Body,
  SetupStep3Body,
} from './schema';
import type {
  AgentParam,
  Channel,
  ChannelGroup,
  CleanEvidence,
  CleanItem,
  CleanQuery,
  CliProfile,
  Credential,
  CursorPage,
  FirstRun,
  IdentityCandidate,
  IdentityEvidence,
  IdentityHistoryItem,
  IdentityStats,
  ListenMode,
  Notebook,
  NotebookCompaction,
  NotebookEntry,
  NotebookSubjectType,
  Pipeline,
  Provider,
  ProviderCreateBody,
  ProviderKey,
  ProviderTestResult,
  RawByGroup,
  RawDetail,
  RawItem,
  RawQuery,
  Ref,
  RefineryRun,
  RefinerySchedule,
  RefineryScheduleConfig,
  Rule,
  RuleBody,
  RuleTestBatchResult,
  RuleTestBody,
  RuleTestResult,
  RuleVersion,
  SetupStep6Body,
  SetupStep7Body,
  Since,
  ViewScope,
  Weight,
  GroupKind,
} from './phase2';

type Q = Record<string, string | number | boolean | null | undefined>;
const enc = encodeURIComponent;

/** Typed endpoints — phase 1, 2 (docs/api/phase-1.md, phase-2.md) and phase 3 (docs/api/phase-3*.md, one factory per cluster). */
export function createEndpoints(client: ApiClient) {
  const r = client.request;
  return {
    auth: {
      login: (body: { email: string; password: string }) =>
        r<Me>('/auth/login', { method: 'POST', body, skipAuthRedirect: true }),
      logout: () => r<void>('/auth/logout', { method: 'POST', skipAuthRedirect: true }),
      me: (signal?: AbortSignal) => r<Me>('/auth/me', { signal }),
      verifyPin: (pin: string) =>
        r<{ pin_verified_until: string }>('/auth/pin/verify', {
          method: 'POST',
          body: { pin },
          skipPinFlow: true,
          skipAuthRedirect: true,
        }),
      changePin: (current_pin: string, new_pin: string) =>
        r<void>('/auth/pin', { method: 'PUT', body: { current_pin, new_pin } }),
    },
    shell: {
      navigation: (signal?: AbortSignal) => r<NavDomain[]>('/navigation', { signal }),
      header: (signal?: AbortSignal) => r<HeaderStatus>('/header', { signal }),
      health: () => r<Health>('/health'),
      ready: () => r<Ready>('/ready'),
    },
    setup: {
      state: (signal?: AbortSignal) =>
        r<SetupState>('/setup/state', { signal, skipAuthRedirect: true, skipSetupRedirect: true }),
      step1: (body: SetupStep1Body) =>
        r<SetupState>('/setup/steps/1', { method: 'PUT', body, skipAuthRedirect: true, skipSetupRedirect: true }),
      step2: (body: SetupStep2Body) =>
        r<SetupState>('/setup/steps/2', { method: 'PUT', body, skipAuthRedirect: true, skipSetupRedirect: true }),
      step3: (body: SetupStep3Body) =>
        r<SetupState>('/setup/steps/3', { method: 'PUT', body, skipSetupRedirect: true }),
      skip: (n: number) =>
        r<SetupState>(`/setup/steps/${n}/skip`, { method: 'POST', skipSetupRedirect: true }),
      step4: (provider_ids: string[]) =>
        r<SetupState>('/setup/steps/4', { method: 'PUT', body: { provider_ids }, skipSetupRedirect: true }),
      step5: () => r<SetupState>('/setup/steps/5', { method: 'PUT', body: {}, skipSetupRedirect: true }),
      step6: (body: SetupStep6Body) =>
        r<SetupState>('/setup/steps/6', { method: 'PUT', body, skipSetupRedirect: true }),
      step7: (body: SetupStep7Body) =>
        r<SetupState>('/setup/steps/7', { method: 'PUT', body, skipSetupRedirect: true }),
      /** Bước 12 "Hoàn tất": bấm nút → PUT như mọi bước khác (phase-1 convention). */
      step12: () => r<SetupState>('/setup/steps/12', { method: 'PUT', body: {}, skipSetupRedirect: true }),
      rulePresets: (signal?: AbortSignal) => r<Rule[]>('/setup/rule-presets', { signal, skipSetupRedirect: true }),
      firstRun: (signal?: AbortSignal) => r<FirstRun>('/setup/first-run', { signal, skipSetupRedirect: true }),
    },
    data: {
      pipeline: (signal?: AbortSignal) => r<Pipeline>('/data/pipeline', { signal }),
    },
    raw: {
      list: (q: RawQuery = {}, signal?: AbortSignal) => r<CursorPage<RawItem>>('/raw', { query: q as Q, signal }),
      get: (id: string, signal?: AbortSignal) => r<RawDetail>(`/raw/${enc(id)}`, { signal }),
      byGroup: (q: { since?: Since; limit?: number } = {}, signal?: AbortSignal) =>
        r<RawByGroup[]>('/raw/by-group', { query: q, signal }),
      /** CSV — needs `data.manage` + PIN (operation `data.export`). */
      exportCsv: (q: Omit<RawQuery, 'cursor' | 'limit'> = {}) =>
        r<string>('/raw/export', { query: q as Q, responseType: 'text' }),
    },
    refinery: {
      schedule: (signal?: AbortSignal) => r<RefinerySchedule>('/refinery/schedule', { signal }),
      setSchedule: (body: RefineryScheduleConfig) =>
        r<RefinerySchedule>('/refinery/schedule', { method: 'PUT', body }),
      run: () => r<{ run_id: string }>('/refinery/run', { method: 'POST' }),
      runs: (limit = 5, signal?: AbortSignal) => r<RefineryRun[]>('/refinery/runs', { query: { limit }, signal }),
    },
    rules: {
      list: (signal?: AbortSignal) => r<Rule[]>('/rules', { signal }),
      versions: (id: string, signal?: AbortSignal) => r<RuleVersion[]>(`/rules/${enc(id)}/versions`, { signal }),
      create: (body: RuleBody) => r<Rule>('/rules', { method: 'POST', body }),
      update: (id: string, body: RuleBody) => r<Rule>(`/rules/${enc(id)}`, { method: 'PUT', body }),
      setEnabled: (id: string, enabled: boolean) => r<Rule>(`/rules/${enc(id)}`, { method: 'PATCH', body: { enabled } }),
      weights: (signal?: AbortSignal) => r<Weight[]>('/rules/weights', { signal }),
      setWeights: (weights: Array<{ dimension: string; value: number }>) =>
        r<Weight[]>('/rules/weights', { method: 'PUT', body: weights }),
      test: (body: RuleTestBody) => r<RuleTestResult>('/rules/test', { method: 'POST', body }),
      testBatch: (n = 100) => r<RuleTestBatchResult>('/rules/test-batch', { method: 'POST', body: { n } }),
    },
    clean: {
      list: (q: CleanQuery = {}, signal?: AbortSignal) => r<CursorPage<CleanItem>>('/clean', { query: q as Q, signal }),
      evidence: (id: string, signal?: AbortSignal) => r<CleanEvidence[]>(`/clean/${enc(id)}/evidence`, { signal }),
      agentParams: (q: { group_id?: string; person_id?: string }, signal?: AbortSignal) =>
        r<AgentParam[]>('/clean/agent-params', { query: q, signal }),
    },
    notebooks: {
      get: (type: NotebookSubjectType, id: string, signal?: AbortSignal) =>
        r<Notebook>(`/notebooks/${type}/${enc(id)}`, { signal }),
      addEntry: (type: NotebookSubjectType, id: string, body: { section: string; body: string; pinned: boolean }) =>
        r<NotebookEntry>(`/notebooks/${type}/${enc(id)}/entries`, { method: 'POST', body }),
      updateEntry: (type: NotebookSubjectType, id: string, eid: string, body: { body?: string; pinned?: boolean }) =>
        r<NotebookEntry>(`/notebooks/${type}/${enc(id)}/entries/${enc(eid)}`, { method: 'PATCH', body }),
      deleteEntry: (type: NotebookSubjectType, id: string, eid: string) =>
        r<void>(`/notebooks/${type}/${enc(id)}/entries/${enc(eid)}`, { method: 'DELETE' }),
      compact: (type: NotebookSubjectType, id: string) =>
        r<Notebook>(`/notebooks/${type}/${enc(id)}/compact`, { method: 'POST' }),
      compactions: (type: NotebookSubjectType, id: string, signal?: AbortSignal) =>
        r<NotebookCompaction[]>(`/notebooks/${type}/${enc(id)}/compactions`, { signal }),
    },
    identity: {
      stats: (signal?: AbortSignal) => r<IdentityStats>('/identity/stats', { signal }),
      candidates: (status = 'pending', signal?: AbortSignal) =>
        r<IdentityCandidate[]>('/identity/candidates', { query: { status }, signal }),
      merge: (id: string) =>
        r<{ person: Ref; log_id: string }>(`/identity/candidates/${enc(id)}/merge`, { method: 'POST' }),
      reject: (id: string) => r<void>(`/identity/candidates/${enc(id)}/reject`, { method: 'POST' }),
      evidence: (id: string, signal?: AbortSignal) =>
        r<IdentityEvidence[]>(`/identity/candidates/${enc(id)}/evidence`, { signal }),
      split: (person_id: string, identity_ids: string[]) =>
        r<Ref>('/identity/split', { method: 'POST', body: { person_id, identity_ids } }),
      history: (signal?: AbortSignal) => r<IdentityHistoryItem[]>('/identity/history', { signal }),
      revert: (logId: string) => r<void>(`/identity/history/${enc(logId)}/revert`, { method: 'POST' }),
    },
    channels: {
      list: (signal?: AbortSignal) => r<Channel[]>('/channels', { signal }),
      login: (type: string, body: { account_label?: string; accept_risk: true }) =>
        r<{ session_id: string }>(`/channels/${enc(type)}/login`, { method: 'POST', body }),
      logout: (type: string) => r<void>(`/channels/${enc(type)}/logout`, { method: 'POST' }),
      /** 🔒 PIN `policy.change`. */
      update: (type: string, body: { listen_direct: boolean }) =>
        r<Channel>(`/channels/${enc(type)}`, { method: 'PATCH', body }),
      groups: (type: string, signal?: AbortSignal) => r<ChannelGroup[]>(`/channels/${enc(type)}/groups`, { signal }),
    },
    groups: {
      update: (id: string, body: { listen_mode?: ListenMode; view_scope?: ViewScope; kind?: GroupKind | string }) =>
        r<ChannelGroup>(`/groups/${enc(id)}`, { method: 'PATCH', body }),
    },
    providers: {
      list: (signal?: AbortSignal) => r<Provider[]>('/providers', { signal }),
      create: (body: ProviderCreateBody) => r<Provider>('/providers', { method: 'POST', body }),
      addKey: (id: string, secret: string) =>
        r<ProviderKey>(`/providers/${enc(id)}/keys`, { method: 'POST', body: { secret } }),
      removeKey: (id: string, kid: string) => r<void>(`/providers/${enc(id)}/keys/${enc(kid)}`, { method: 'DELETE' }),
      update: (id: string, body: { enabled?: boolean; failover_rank?: number }) =>
        r<Provider>(`/providers/${enc(id)}`, { method: 'PATCH', body }),
      test: (id: string) => r<ProviderTestResult>(`/providers/${enc(id)}/test`, { method: 'POST' }),
      addModel: (id: string, body: { model_name: string; daily_quota?: number; rate_limit_per_min?: number }) =>
        r<Provider>(`/providers/${enc(id)}/models`, { method: 'POST', body }),
      credentials: (signal?: AbortSignal) => r<Credential[]>('/providers/credentials', { signal }),
    },
    cli: {
      profiles: (signal?: AbortSignal) => r<CliProfile[]>('/cli/profiles', { signal }),
      login: () => r<{ login_id: string }>('/cli/login', { method: 'POST' }),
      /** 202 {}; 409 CLI_LOGIN_NOT_WAITING when the login is not at `waiting_code`. */
      submitCode: (loginId: string, code: string) =>
        r<Record<string, never>>(`/cli/login/${enc(loginId)}/code`, { method: 'POST', body: { code } }),
      cancelLogin: (loginId: string) => r<void>(`/cli/login/${enc(loginId)}/cancel`, { method: 'POST' }),
      activate: (id: string) => r<CliProfile>(`/cli/profiles/${enc(id)}/activate`, { method: 'POST' }),
      remove: (id: string) => r<void>(`/cli/profiles/${enc(id)}`, { method: 'DELETE' }),
    },
    audit: {
      list: (q: { cursor?: string; limit?: number; actor_type?: string; action?: string } = {}) =>
        r<AuditPage>('/audit', { query: q }),
      verify: () => r<AuditVerify>('/audit/verify'),
    },
    plugins: {
      list: () => r<Plugin[]>('/plugins'),
      toggle: (pkg: string, enabled: boolean) =>
        r<Plugin>(`/plugins/${encodeURIComponent(pkg)}/toggle`, { method: 'PATCH', body: { enabled } }),
      remove: (pkg: string) => r<void>(`/plugins/${encodeURIComponent(pkg)}`, { method: 'DELETE' }),
    },
    ...coreEndpoints(r),
    queue: queueEndpoints(r),
    relations: relationsEndpoints(r),
    graph: graphEndpoints(r),
    market: marketEndpoints(r),
    people: peopleEndpoints(r),
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
