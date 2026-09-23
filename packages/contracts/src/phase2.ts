/**
 * Phase-2 API types, hand-written from docs/api/phase-2.md (tầng dữ liệu,
 * kênh, bộ não AI, trình thiết lập 4–7 + 12, WebSocket). Numbers are raw —
 * the web formats them (18.412, 0,94, 15 phút). Times are ISO 8601 UTC.
 *
 * Where the contract leaves a shape open (rule outputs, history parties) the
 * type is kept permissive and the gap is noted next to it.
 */

// ── shared ────────────────────────────────────────────────────────────────
export type ChannelType = 'zalo' | 'whatsapp' | 'telegram' | 'linkedin';

/** Every object carries both `id` (uuid) and its public `code` (GRP-ZL-0114, PER-0042…). */
export interface Ref {
  id: string;
  code: string;
  name: string;
}

/** Cursor page `?cursor=&limit=` → `{items, next_cursor, total}`. */
export interface CursorPage<T> {
  items: T[];
  next_cursor: string | null;
  total: number;
}

export type Since = '24h' | '7d' | '30d' | 'all';

// ── pipeline strip ────────────────────────────────────────────────────────
export interface Pipeline {
  channels_live: number;
  groups_listening: number;
  raw_total: number;
  raw_pending: number;
  interval_seconds: number;
  count_threshold: number;
  clean_total: number;
}

// ── raw lake ──────────────────────────────────────────────────────────────
export type RawState = 'pending' | 'processing' | 'clean' | 'lowconf' | 'discarded' | 'error';

export interface RawItem {
  id: string;
  code: string;
  received_at: string;
  occurred_at: string;
  channel: { type: ChannelType | string; name: string };
  group: Ref | null;
  person: Ref | null;
  direction: 'inbound' | 'outbound';
  kind: string;
  text: string;
  label: string | null;
  confidence: number | null;
  state: RawState;
}

export interface RawDetail extends RawItem {
  payload: Record<string, unknown>;
  meaning_units: Array<{ id: string; event_type: string; conclusion: string }>;
}

export interface RawQuery {
  cursor?: string;
  limit?: number;
  channel?: string;
  group_id?: string;
  state?: RawState | '';
  since?: Since;
  label?: string;
  min_confidence?: number;
}

export interface RawByGroup {
  /** `null` for an aggregated "other groups" row, if the server sends one. */
  group: Ref | null;
  n: number;
}

/** WS `raw.state`. */
export interface RawStateEvent {
  id: string;
  state: RawState;
  label: string | null;
  confidence: number | null;
}

// ── refinery ──────────────────────────────────────────────────────────────
export interface RefineryScheduleConfig {
  interval_seconds: number;
  count_threshold: number;
  batch_size: number;
  min_confidence: number;
}

export interface RefinerySchedule extends RefineryScheduleConfig {
  pending: number;
  next_run_at: string;
  next_trigger: 'interval' | 'count';
}

export type RefineryTrigger = 'schedule' | 'threshold' | 'manual' | 'fast';

export interface RefineryRun {
  id: string;
  trigger: RefineryTrigger;
  started_at: string;
  finished_at: string | null;
  input_count: number;
  clean_count: number;
  lowconf_count: number;
  noise_count: number;
  error_count: number;
  /** `queued`: a manual run waiting for the worker (shown like running). */
  status: 'queued' | 'running' | 'done' | 'failed';
}

/** WS `refinery.progress`. */
export interface RefineryProgress {
  run_id: string;
  processed: number;
  total: number;
  clean: number;
  lowconf: number;
  noise: number;
  errors: number;
  status: 'queued' | 'running' | 'done' | 'failed';
}

// ── rules ─────────────────────────────────────────────────────────────────
export type RuleKind = 'intent' | 'risk' | 'competition' | 'hr' | 'hygiene' | 'custom';

export type RuleConditionType =
  | 'keyword_any'
  | 'keyword_all'
  | 'regex'
  | 'has_entity'
  | 'min_words'
  | 'max_words'
  | 'is_question'
  | 'kind_in'
  | 'repeat_unanswered'
  | 'llm';

export interface RuleCondition {
  type: RuleConditionType;
  values?: string[];
  pattern?: string;
  entity?: string;
  n?: number;
  hint?: string;
  /** R-06 "dưới 4 từ và không có thực thể" (API presets). */
  no_entity?: boolean;
  /** Human label shown on the card ("có từ khoá số lượng + đơn vị"). */
  label?: string;
}

/**
 * Contract: `set {field, value}`, `add {field, value}`, `discard`, `alert {priority}`,
 * example `{"set": "intent", "value": "AskedPrice", "label": "…"}`. The exact
 * encoding of discard/alert is not spelled out; the API presets use
 * `{"discard": true}` and `{"alert": "P1"}`, which the web writes too.
 */
export interface RuleOutput {
  set?: string;
  add?: string;
  discard?: boolean;
  alert?: boolean | string;
  priority?: string;
  value?: string | number;
  label?: string;
}

export interface Rule {
  id: string;
  code: string;
  name: string;
  kind: RuleKind | string;
  kind_label: string;
  enabled: boolean;
  version: number;
  threshold: number;
  hits_24h: number;
  conditions: RuleCondition[];
  outputs: RuleOutput[];
  prompt_hint: string | null;
  updated_at: string;
}

export interface RuleBody {
  name: string;
  kind: RuleKind | string;
  conditions: RuleCondition[];
  outputs: RuleOutput[];
  threshold: number;
  prompt_hint: string | null;
}

export interface RuleVersion {
  version: number;
  conditions: RuleCondition[];
  outputs: RuleOutput[];
  threshold: number;
  created_at: string;
  created_by: string | { id?: string; label?: string; name?: string; display_name?: string } | null;
}

export interface Weight {
  dimension: string;
  label: string;
  /** Integer percent; all weights sum to 100. */
  value: number;
}

export type RuleTestBody = { raw_event_id: string } | { text: string; group_id?: string; person_id?: string };

export interface RuleTestResult {
  input: { code: string | null; text: string };
  output: Array<{ key: string; value: string }>;
  matched_rules: string[];
  discarded_by: string | null;
  confidence: number | null;
  would_write: 'clean' | 'lowconf' | 'discarded';
}

export interface RuleTestBatchResult {
  n: number;
  clean: number;
  lowconf: number;
  discarded: number;
  by_rule: Array<{ code: string; hits: number }>;
}

// ── clean store ───────────────────────────────────────────────────────────
export interface CleanItem {
  id: string;
  observed_at: string;
  group: Ref | null;
  person: Ref | null;
  event_type: string;
  conclusion: string;
  /** Weighted total 0–100. */
  score: number;
  confidence: number;
  cycle_at: string;
  raw_event_ids: string[];
}

export interface CleanQuery {
  cursor?: string;
  limit?: number;
  group_id?: string;
  person_id?: string;
  since?: Since;
}

export interface CleanEvidence {
  raw: RawItem;
  quote: string;
}

export interface AgentParam {
  key: string;
  label: string;
  value: string;
  /** Phosphor class. */
  icon: string;
}

// ── notebooks (core) ──────────────────────────────────────────────────────
export type NotebookSubjectType = 'person' | 'group';
export type NotebookSectionKey = 'attention_now' | 'rolling_context' | 'guardrails' | 'preferences' | 'open_threads';

export interface NotebookEntry {
  id: string;
  body: string;
  refs: Array<{ type: string; id: string; code: string }>;
  author: { type: 'agent' | 'user'; label: string };
  pinned: boolean;
  created_at: string;
}

export interface NotebookSection {
  key: NotebookSectionKey | string;
  title: string;
  updated_at: string | null;
  entries: NotebookEntry[];
}

export interface Notebook {
  id: string;
  subject: { type: NotebookSubjectType; id: string; code: string; name: string };
  token_used: number;
  token_budget: number;
  compaction_no: number;
  last_compacted_at: string | null;
  sections: NotebookSection[];
}

export interface NotebookCompaction {
  compaction_no: number;
  at: string;
  tokens_before: number;
  tokens_after: number;
  archived: number;
  summary: string;
}

// ── identity ──────────────────────────────────────────────────────────────
export interface IdentityStats {
  merged_people: number;
  live_profiles: number;
  pending_pairs: number;
  manual_splits: number;
  unlinked_accounts: number;
}

export interface IdentitySide {
  identity_id: string;
  person: Ref;
  channel: ChannelType | string;
  meta: string;
}

export interface IdentityCandidate {
  id: string;
  confidence: number;
  level: 'high' | 'mid' | 'low';
  basis: string;
  basis_detail: Record<string, unknown>;
  a: IdentitySide;
  b: IdentitySide;
}

export interface IdentityEvidence {
  raw: RawItem;
  note: string;
}

/**
 * History parties are `{…}` in the contract. The web reads `id/code/name`, and
 * — only when present — `identities` to offer a manual split (gap: no endpoint
 * lists a person's channel identities).
 */
export interface IdentityHistoryParty {
  id?: string;
  code?: string;
  name?: string;
  identities?: Array<{ identity_id: string; channel?: string; meta?: string }>;
}

export interface IdentityHistoryItem {
  id: string;
  op: 'merge' | 'split';
  at: string;
  actor: string | { label?: string; name?: string; display_name?: string } | null;
  from: IdentityHistoryParty;
  to: IdentityHistoryParty;
  identities: number;
  reverted: boolean;
}

// ── channels & groups ─────────────────────────────────────────────────────
export type ChannelState =
  | 'active'
  | 'pending_qr'
  | 'expired'
  | 'logged_out'
  | 'error'
  | 'not_installed'
  | 'identity_only';

export interface ChannelQr {
  session_id: string;
  image: string;
  expires_at: string;
  scanned: boolean;
}

export interface ChannelStats {
  msgs_24h: number | null;
  tagged_24h: number | null;
  latency_ms: number | null;
  uptime_pct: number | null;
  /** LinkedIn (`identity_only`): linked identities / identities merged into a person. */
  identities?: number | null;
  merged?: number | null;
}

export interface Channel {
  type: ChannelType;
  name: string;
  installed: boolean;
  id: string | null;
  state: ChannelState;
  account_label: string | null;
  started_at: string | null;
  groups_listening: number;
  outbound_queued: number;
  last_heartbeat_at: string | null;
  stats: ChannelStats | null;
  qr: ChannelQr | null;
  /** QR channels: listen to 1-1 (direct) messages too. `PATCH /channels/{type}` 🔒 `policy.change`. */
  listen_direct?: boolean;
  session_id?: string | null;
  ended_at?: string | null;
  /** Last bridge error for this channel, if any. */
  error?: string | null;
}

export type ListenMode = 'off' | 'tagged_only' | 'silent' | 'proactive' | 'paused';
export type ViewScope = 'owner' | 'manager' | 'all_members';
export type GroupKind = 'internal' | 'market' | 'partner' | 'customer' | 'private';

export interface ChannelGroup {
  id: string;
  code: string;
  name: string;
  members: number;
  kind: GroupKind | string;
  listen_mode: ListenMode;
  view_scope: ViewScope;
}

/** WS `channel.qr`. */
export interface ChannelQrEvent {
  type: ChannelType;
  session_id: string;
  image: string;
  expires_at: string;
}

/** WS `channel.status`. */
export interface ChannelStatusEvent {
  type: ChannelType;
  state: ChannelState;
  account_label: string | null;
  scanned: boolean;
}

// ── AI brain ──────────────────────────────────────────────────────────────
export type ProviderKind = 'antigravity_cli' | 'gemini' | 'deepseek' | 'openai_compat';

export interface ProviderKey {
  id: string;
  label: string;
  last4: string;
  enabled: boolean;
  cooldown_until: string | null;
  quota_left_pct: number | null;
}

export interface ProviderModel {
  id: string;
  model_name: string;
  daily_quota: number | null;
  used_today: number;
}

export interface Provider {
  id: string;
  kind: ProviderKind;
  name: string;
  endpoint: string | null;
  failover_rank: number;
  enabled: boolean;
  auth_state: 'ok' | 'expiring' | 'expired' | 'error' | 'unconfigured';
  keys: ProviderKey[];
  models: ProviderModel[];
}

export interface ProviderCreateBody {
  kind: ProviderKind;
  name: string;
  endpoint?: string;
  keys: string[];
  models?: string[];
}

export interface ProviderTestResult {
  ok: boolean;
  latency_ms: number | null;
  models: string[];
  error: string | null;
}

export interface Credential {
  icon: string;
  name: string;
  meta: string;
  state: 'ok' | 'warn' | 'bad';
  state_label: string;
}

export interface CliProfile {
  id: string;
  email: string;
  plan_label: string | null;
  active: boolean;
  expires_at: string | null;
  state: 'ok' | 'expiring' | 'expired';
}

/**
 * WS `cli.login` — URL + paste-back-code flow (contract addendum): at
 * `waiting_code` the Console shows `url` and a "Mã xác thực" field, then
 * `POST /cli/login/{login_id}/code {code}`.
 */
export type CliLoginStatus = 'starting' | 'waiting_code' | 'verifying' | 'done' | 'failed';

export interface CliLoginEvent {
  login_id: string;
  status: CliLoginStatus;
  url?: string | null;
  message?: string | null;
  profile?: CliProfile;
}

// ── setup 4–7, 12 ─────────────────────────────────────────────────────────
export interface SetupStep6Body {
  groups: Array<{ id: string; listen_mode: ListenMode; view_scope: ViewScope }>;
}

export interface SetupStep7Body {
  interval_seconds: number;
  count_threshold: number;
  min_confidence: number;
  rule_codes: string[];
  weights: Array<{ dimension: string; value: number }>;
}

export interface FirstRun {
  raw_collected: number;
  classifying: number;
  clean: number;
  lowconf: number;
  discarded: number;
  run: RefineryRun | null;
}

// ── WebSocket /ws ─────────────────────────────────────────────────────────
export interface HeaderEvent {
  channels_live: number;
  groups_listening: number;
  autonomy_level: number;
  data_confidence: number | null;
}

export interface RealtimeEventMap {
  'raw.new': RawItem;
  'raw.state': RawStateEvent;
  'refinery.progress': RefineryProgress;
  'refinery.run': RefineryRun;
  'channel.qr': ChannelQrEvent;
  'channel.status': ChannelStatusEvent;
  'cli.login': CliLoginEvent;
  header: HeaderEvent;
  pong: Record<string, never>;
}

export type RealtimeEventType = keyof RealtimeEventMap;

/** Server frame: `{"type": "…", "data": {…}, "at": "…"}`. */
export type RealtimeEvent = {
  [K in RealtimeEventType]: { type: K; data: RealtimeEventMap[K]; at?: string };
}[RealtimeEventType];

/** Close codes. */
export const WS_CLOSE_UNAUTHENTICATED = 4401;
export const WS_CLOSE_SETUP_REQUIRED = 4428;
