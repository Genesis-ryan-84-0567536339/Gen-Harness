import type { ApiClient } from './client';
import { accountEndpoints } from './account';
import { usersEndpoints } from './users';
import { genEndpoints } from './gen';
import { notificationsEndpoints } from './notifications';
import { socialEndpoints } from './social';
import { pickersEndpoints } from './pickers';
import { coreEndpoints } from './p3-core';
import { queueEndpoints } from './p3-queue';
import { relationsEndpoints } from './p3-relations';
import { graphEndpoints } from './p3-graph';
import { marketEndpoints } from './p3-market';
import { peopleEndpoints } from './p3-people';
import { agentsEndpoints } from './p4-agents';
import { agentModelEndpoints } from './p4-api';
import type { BackgroundSources, BackgroundSourcesBody } from './p4-api';
import { mcpEndpoints } from './p4-mcp';
import { bossChecksEndpoints } from './bossChecks';
import { telegramEndpoints } from './telegram';
import { diagnosticsEndpoints } from './diagnostics';
import { pluginsEndpoints } from './p4-plugins';
import { systemEndpoints } from './p4-system';
import type { Step10Body, Step11Body, Step10Invited, BackupConfig, Step8Body, Step8Agent, Step9Body, Step9State, SetupFollowUpItem } from './p4-system';
import type {
  AuditPage,
  AuditVerify,
  HeaderStatus,
  Health,
  Me,
  NavDomain,
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
  CliLoginEvent,
  CliProfile,
  CliKind,
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
  ProviderDiagnosis,
  Effort,
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
      /** Bước 8 "Agent đầu tiên" — tạo agent và thử trò chuyện một lượt (`try_reply` null kèm `try_error` khi model chưa gọi được). */
      step8: (body: Step8Body) =>
        r<SetupState & { agent: Step8Agent }>('/setup/steps/8', { method: 'PUT', body, skipSetupRedirect: true }),
      /** Bước 9 "Tự trị & ranh giới" — mức 3 hoặc 4, bắt xác nhận đã đọc ranh giới khoá cứng. */
      step9: (body: Step9Body) =>
        r<SetupState & { hard_boundaries: string[]; agent?: Step9State['agent'] }>('/setup/steps/9', { method: 'PUT', body, skipSetupRedirect: true }),
      /** Agent của bước 9 + mức tự trị hiện tại — form điền sẵn (mở lại sau Hoàn tất không đổi nhầm mức). */
      step9State: (signal?: AbortSignal) => r<Step9State>('/setup/steps/9', { signal, skipSetupRedirect: true }),
      hardBoundaries: (signal?: AbortSignal) => r<string[]>('/setup/hard-boundaries', { signal, skipSetupRedirect: true }),
      followUp: (signal?: AbortSignal) => r<SetupFollowUpItem[]>('/setup/follow-up', { signal }),
      /** Bước 10 "Mời đội ngũ" (tuỳ chọn, GĐ 4.6) — trả kèm `invited` (mật khẩu tạm, chưa có SMTP thật). */
      step10: (body: Step10Body) =>
        r<SetupState & { invited: Step10Invited[] }>('/setup/steps/10', { method: 'PUT', body, skipSetupRedirect: true }),
      /** Bước 11 "Sao lưu" (tuỳ chọn, GĐ 4.6) — chỉ lưu LỊCH/ĐÍCH, trả kèm `backup`. */
      step11: (body: Step11Body) =>
        r<SetupState & { backup: BackupConfig }>('/setup/steps/11', { method: 'PUT', body, skipSetupRedirect: true }),
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
      /** Kéo-thả sắp lại toàn bộ chuỗi chuyển hướng một lượt (PLAN 4.2) — khác `update` vốn chỉ đổi một ô. */
      chain: (providerIds: string[]) => r<Provider[]>('/providers/chain', { method: 'PATCH', body: { provider_ids: providerIds } }),
      test: (id: string) => r<ProviderTestResult>(`/providers/${enc(id)}/test`, { method: 'POST' }),
      /** v0.1.28 (UX N1): xoá nguồn nhập nhầm / gọi thử lỗi (không áp dụng cho Antigravity CLI). */
      remove: (id: string) => r<void>(`/providers/${enc(id)}`, { method: 'DELETE' }),
      /** v0.1.31: nguồn CLI gọi thử model MỚI trước khi lưu (422 `model_name` khi CLI không nhận); `make_default` = "Dùng model này". */
      addModel: (
        id: string,
        body: { model_name: string; daily_quota?: number; rate_limit_per_min?: number; make_default?: boolean; effort?: Effort | null },
      ) => r<Provider>(`/providers/${enc(id)}/models`, { method: 'POST', body }),
      /** v0.1.32 (chỉ Owner): chẩn đoán nguồn CLI — phiên bản, liệt kê model, một lượt gọi rất ngắn; đầu ra thô đã che. */
      diagnose: (id: string) => r<ProviderDiagnosis>(`/providers/${enc(id)}/diagnose`, { method: 'POST' }),
      credentials: (signal?: AbortSignal) => r<Credential[]>('/providers/credentials', { signal }),
      /** v0.1.41 (F-86): nguồn AI cho việc nền (`system.read`). */
      background: (signal?: AbortSignal) => r<BackgroundSources>('/providers/background', { signal }),
      /** v0.1.41 (F-86): chỉ Owner; thêm CLI cần PIN `ai.background_cli` + `accept_risk` (423/422), bỏ CLI không cần PIN. */
      setBackground: (body: BackgroundSourcesBody) =>
        r<BackgroundSources>('/providers/background', { method: 'PUT', body }),
    },
    cli: {
      profiles: (signal?: AbortSignal, kind: CliKind = 'antigravity_cli') =>
        r<CliProfile[]>('/cli/profiles', { signal, ...(kind !== 'antigravity_cli' ? { query: { kind } } : {}) }),
      login: (kind: CliKind = 'antigravity_cli') =>
        r<{ login_id: string }>('/cli/login', { method: 'POST', ...(kind !== 'antigravity_cli' ? { query: { kind } } : {}) }),
      /** 202 {}; 409 CLI_LOGIN_NOT_WAITING when the login is not at `waiting_code`. */
      submitCode: (loginId: string, code: string) =>
        r<Record<string, never>>(`/cli/login/${enc(loginId)}/code`, { method: 'POST', body: { code } }),
      /** v0.1.30: trạng thái phiên đăng nhập — dự phòng khi WS `cli.login` không tới. */
      loginStatus: (loginId: string, signal?: AbortSignal) =>
        r<CliLoginEvent>(`/cli/login/${enc(loginId)}`, { signal, skipPinFlow: true }),
      cancelLogin: (loginId: string) => r<void>(`/cli/login/${enc(loginId)}/cancel`, { method: 'POST' }),
      activate: (id: string) => r<CliProfile>(`/cli/profiles/${enc(id)}/activate`, { method: 'POST' }),
      remove: (id: string) => r<void>(`/cli/profiles/${enc(id)}`, { method: 'DELETE' }),
    },
    audit: {
      list: (q: { cursor?: string; limit?: number; actor_type?: string; action?: string } = {}) =>
        r<AuditPage>('/audit', { query: q }),
      verify: () => r<AuditVerify>('/audit/verify'),
    },
    ...coreEndpoints(r),
    queue: queueEndpoints(r),
    relations: relationsEndpoints(r),
    graph: graphEndpoints(r),
    market: marketEndpoints(r),
    people: peopleEndpoints(r),
    ...agentsEndpoints(r),
    ...agentModelEndpoints(r),
    ...mcpEndpoints(r),
    ...pluginsEndpoints(r),
    ...systemEndpoints(r),
    ...accountEndpoints(r),
    ...usersEndpoints(r),
    ...genEndpoints(r),
    ...notificationsEndpoints(r),
    ...socialEndpoints(r),
    ...pickersEndpoints(r),
    /** v0.1.39 (F-74): "Việc Sếp cần làm" — kết quả kiểm lưu ở máy chủ. */
    bossChecks: bossChecksEndpoints(r),
    /** v0.1.44 (F-8c): Kết nối › Telegram ("Báo động & bản tin") — chỉ Owner. */
    notify: telegramEndpoints(r),
    /** v0.1.44 (F-4b): Gói chẩn đoán cho người hỗ trợ — chỉ Owner. */
    diagnostics: diagnosticsEndpoints(r),
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
