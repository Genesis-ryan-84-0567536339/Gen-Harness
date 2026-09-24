/** Hợp đồng API giai đoạn 3 · Hàng đợi & Hành động (docs/api/phase-3-queue.md). */
import type { ApiClient } from './client';
import type { AgentRef, EvidenceRef, ExplainUnit, GroupRef, PersonRef, UserRef } from './p3-core';

// ─── Tổng quan điều hành ────────────────────────────────────────────────────
export interface KpiItem {
  key: string;
  label: string;
  value: number | string | null;
  unit: string | null;
  row: 1 | 2;
  status: 'ok' | 'warn' | 'bad';
  sublabel: string | null;
  pct: number | null;
  filter: { screen: string; filters: Record<string, string> } | null;
}
export type QueueWidgetKind = 'opportunity' | 'alert' | 'draft' | 'due';
export interface QueueWidgetItem {
  kind: QueueWidgetKind;
  id: string;
  code: string | null;
  title: string;
  priority: 'P1' | 'P2' | 'P3';
  at: string | null;
  due_at: string | null;
}
export type SpotlightDimension = 'heat' | 'churn_risk';
export interface SpotlightItem {
  person: PersonRef;
  dimension: SpotlightDimension;
  value: number;
  at: string;
}
export interface SignalItem {
  topic: string;
  count: number;
  delta_pct: number | null;
}
export interface OverviewHealth {
  channels: { type: string; active: number }[];
  plugins: { healthy: number; degraded: number; isolated: number };
  backlog_pending: number;
}
export interface OverviewDataQuality {
  missing_identity_pct: number;
  low_confidence_score_pct: number;
  unassigned_event_pct: number;
}
export interface HourlyPoint {
  hour: string;
  count: number;
}
export interface Overview {
  kpis: KpiItem[];
  queue: QueueWidgetItem[];
  spotlight: SpotlightItem[];
  signals: SignalItem[];
  health: OverviewHealth;
  dataQuality: OverviewDataQuality;
  hourly: HourlyPoint[];
}

// ─── Hộp thư ý nghĩa ────────────────────────────────────────────────────────
export type InboxTab = 'all' | 'opportunity' | 'alert' | 'approval' | 'reply' | 'candidate';
export type InboxItemType = 'unit' | 'alert' | 'draft';
export type ConfidenceBandLabel = 'cao' | 'trung bình' | 'thấp';

export interface InboxItem {
  id: string;
  code: string | null;
  item_type: InboxItemType;
  tab: InboxTab;
  title: string;
  summary: string | null;
  priority: 'P1' | 'P2' | 'P3';
  created_at: string;
  score: number | null;
  confidence_band: ConfidenceBandLabel | null;
  subject: (PersonRef | GroupRef) | null;
  group: GroupRef | null;
  agent: AgentRef | null;
  alert_type: string | null;
  alert_type_label: string | null;
  suggested_action: string | null;
}
export interface InboxPage {
  items: InboxItem[];
  next_cursor: string | null;
  total: number;
  counts: Record<InboxTab, number>;
}
export interface InboxDetail extends InboxItem {
  units: ExplainUnit[];
  /** Có khi `item_type` là `alert` (`open|acknowledged`) hoặc `draft` (trạng thái bản nháp). */
  status?: string;
  /** Chỉ có khi `item_type = 'draft'`. */
  kind?: string;
}
export interface InboxActResult {
  ok: true;
  status?: string;
  draft?: { id: string; code: string; status: string };
}
export interface InboxAssignResult {
  ok: true;
  assigned_to: { id: string; name: string };
}

// ─── Việc & Nhắc hẹn ────────────────────────────────────────────────────────
export type TaskStatus = 'todo' | 'doing' | 'done' | 'cancelled';
export type TaskPriority = 'P1' | 'P2' | 'P3';
export type TaskSource = 'promise' | 'draft' | 'manual';
export interface Task {
  id: string;
  code: string;
  title: string;
  priority: TaskPriority;
  status: TaskStatus;
  assignee: UserRef | null;
  subject: (PersonRef | GroupRef) | null;
  due_at: string | null;
  remind_at: string | null;
  overdue: boolean;
  source: TaskSource;
  created_at: string;
  completed_at: string | null;
}
export interface TaskPage {
  items: Task[];
  next_cursor: string | null;
  total: number;
}
export interface TaskCreateBody {
  title: string;
  priority?: TaskPriority;
  assignee_user_id?: string;
  subject?: { type: 'person' | 'group'; id: string };
  due_at?: string | null;
  remind_at?: string | null;
}
export interface TaskPatchBody {
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee_user_id?: string | null;
  due_at?: string | null;
  remind_at?: string | null;
}

// ─── Lời hứa ────────────────────────────────────────────────────────────────
export type PromiseStatus = 'upcoming' | 'overdue' | 'kept' | 'all';
export interface Promise {
  id: string;
  text: string;
  due_at: string;
  kept_at: string | null;
  broken: boolean;
  from: PersonRef;
  to: PersonRef | null;
  evidence: EvidenceRef | null;
}
export interface PromisePage {
  items: Promise[];
  next_cursor: string | null;
  total: number;
}

type Q = Record<string, string | number | boolean | null | undefined>;
const enc = encodeURIComponent;

/** Endpoint của cụm — gộp vào `createEndpoints` dưới khoá `queue` (vd `api.queue.overview()`). */
export function queueEndpoints(r: ApiClient['request']) {
  return {
    overview: (signal?: AbortSignal) => r<Overview>('/overview', { signal }),
    inbox: {
      list: (
        q: { tab?: InboxTab; intent?: string; cursor?: string; limit?: number } = {},
        signal?: AbortSignal,
      ) => r<InboxPage>('/inbox', { query: q as Q, signal }),
      get: (id: string, signal?: AbortSignal) => r<InboxDetail>(`/inbox/${enc(id)}`, { signal }),
      act: (id: string, body: { text?: string; create_task?: boolean } = {}) =>
        r<InboxActResult>(`/inbox/${enc(id)}/act`, { method: 'POST', body }),
      assign: (id: string, userId: string) =>
        r<InboxAssignResult>(`/inbox/${enc(id)}/assign`, { method: 'POST', body: { user_id: userId } }),
      silence: (id: string, body: { reason?: string | null; until?: string | null } = {}) =>
        r<{ ok: true }>(`/inbox/${enc(id)}/silence`, { method: 'POST', body }),
    },
    tasks: {
      list: (
        q: {
          status?: TaskStatus;
          priority?: TaskPriority;
          overdue?: boolean;
          assignee_user_id?: string;
          cursor?: string;
          limit?: number;
        } = {},
        signal?: AbortSignal,
      ) => r<TaskPage>('/tasks', { query: q as Q, signal }),
      get: (id: string, signal?: AbortSignal) => r<Task>(`/tasks/${enc(id)}`, { signal }),
      create: (body: TaskCreateBody) => r<Task>('/tasks', { method: 'POST', body }),
      update: (id: string, body: TaskPatchBody) => r<Task>(`/tasks/${enc(id)}`, { method: 'PATCH', body }),
      promises: {
        list: (
          q: { status?: PromiseStatus; cursor?: string; limit?: number } = {},
          signal?: AbortSignal,
        ) => r<PromisePage>('/tasks/promises', { query: q as Q, signal }),
        keep: (id: string, kept: boolean) =>
          r<{ ok: true }>(`/tasks/promises/${enc(id)}`, { method: 'PATCH', body: { kept } }),
      },
    },
  };
}
