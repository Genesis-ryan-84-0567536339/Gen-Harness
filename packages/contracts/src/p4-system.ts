/**
 * Hợp đồng API giai đoạn 4 · Điều khiển hệ thống (PLAN 4.5/4.6, ARCHITECTURE §7.4/§8.3/§11,
 * `apps/api/gh/system_api/routes.py` + `apps/api/gh/setup/routes.py`).
 *
 * Chỉ phần MỚI của 4.5/4.6: ma trận quyền (`/permissions`), nhóm đang lắng nghe (`/listening-groups`), ranh
 * giới có trách nhiệm (`/boundaries*`), nhật ký hệ thống (`/audit-log*` — cùng đường đọc `gh.audit.routes`
 * với `/audit` đã có, chỉ thêm bộ lọc theo đối tượng/thời gian nên tái dùng `AuditItem`/`AuditPage` của
 * `schema.ts`), Dữ liệu & lưu trữ (`/retention-policies`, `/persons/{id}/data-requests` — spec I), và bước
 * thiết lập 10–11 (`/setup/steps/10`, `/setup/steps/11`). "Bộ não AI" (`/providers*`, `/cli/*`,
 * `/failover-rules`, `PATCH /providers/chain`) đã có hợp đồng từ giai đoạn 2/4.2 ở `endpoints.ts`/`p4-api.ts`
 * — màn `system` chỉ ĐỌC LẠI các hook đó (`useProviders`, `useCliProfiles`, `useFailoverRules`), KHÔNG lặp lại
 * ở đây.
 */
import type { ApiClient } from './client';
import type { AuditPage } from './schema';
import type { GroupKind, ListenMode, ViewScope } from './phase2';

// ── Quyền hạn: ma trận ───────────────────────────────────────────────────────

export type PermScope = 'all' | 'team' | 'assigned' | 'none';

export interface PermissionColumn {
  key: string;
  label: string;
  permissions: string[];
}

export interface PermissionRole {
  code: 'owner' | 'manager' | 'operator' | 'agent_staff' | 'auditor';
  name: string;
  meta: string;
  permissions: Record<string, PermScope>;
}

export interface PermissionsPage {
  columns: PermissionColumn[];
  roles: PermissionRole[];
}

export interface PermissionPatchBody {
  role: PermissionRole['code'];
  permission: string;
  scope: PermScope;
}

// ── Quyền hạn: nhóm đang lắng nghe ───────────────────────────────────────────

/** `/listening-groups` — cùng hình `ChannelGroup` (phase2) + `channel`/`msgs_24h` (thiết kế `listenGroups`). */
export interface ListeningGroup {
  id: string;
  code: string;
  name: string;
  members: number;
  kind: GroupKind | string;
  listen_mode: ListenMode;
  view_scope: ViewScope;
  channel: string;
  msgs_24h: number;
}

// ── Quyền hạn: ranh giới có trách nhiệm ──────────────────────────────────────

export interface Boundary {
  code: string;
  label: string;
  enabled: boolean;
  locked: boolean;
  params: Record<string, unknown>;
}

export interface BoundaryPatchBody {
  enabled?: boolean;
  params?: Record<string, unknown>;
}

/**
 * 2 trong 8 khoá cứng ARCHITECTURE §7.4 không có dòng `ops.policy_boundaries` (bất biến ở tầng mã nguồn/CSDL,
 * không phải công tắc) — hiển thị tĩnh cạnh 6 dòng thật từ `/boundaries` để đủ "8 khoá cứng" thiết kế đòi hỏi.
 */
export const STATIC_HARD_BOUNDARIES: ReadonlyArray<{ label: string; hint: string }> = [
  { label: 'Kho thô và Nhật ký hành động chỉ được ghi thêm, không sửa/xoá', hint: 'Bất biến tầng CSDL — không có công tắc, kể cả Owner.' },
  { label: 'PIN cho thao tác nhạy cảm; bí mật được mã hoá', hint: 'Bất biến tầng mã nguồn — không có công tắc.' },
];

// ── Nhật ký hệ thống ──────────────────────────────────────────────────────────

export interface SystemAuditQuery {
  cursor?: string;
  limit?: number;
  actor_type?: string;
  action?: string;
  target_type?: string;
  target_id?: string;
  since?: string;
  until?: string;
}

// ── Dữ liệu & lưu trữ (spec I) ───────────────────────────────────────────────

export type RetentionDataset = 'raw.events' | 'clean.meaning_units' | 'ops.action_log' | 'memory.entries' | 'agent.model_calls';

export interface RetentionPolicy {
  dataset: RetentionDataset;
  keep_days: number | null;
  anonymize_after_days: number | null;
}

export interface RetentionPatchBody {
  dataset: RetentionDataset;
  keep_days?: number | null;
  anonymize_after_days?: number | null;
}

export type DataRequestKind = 'export' | 'erase' | 'restrict';

export interface DataRequestResult {
  id: string;
  kind: DataRequestKind;
  status: string;
  result: unknown;
}

export interface DataRequestRecord {
  id: string;
  kind: DataRequestKind;
  status: string;
  requested_at: string;
  completed_at: string | null;
}

// ── Trình thiết lập bước 10–11 (giai đoạn 4.6) ───────────────────────────────

export interface Step10Invite {
  display_name: string;
  email: string;
  role: 'manager' | 'operator' | 'agent_staff' | 'auditor';
}

export interface Step10Body {
  invites: Step10Invite[];
}

export interface Step10Invited extends Step10Invite {
  id: string;
  temp_password: string;
}

export interface Step11Body {
  frequency: 'daily' | 'weekly' | 'monthly';
  time_of_day: string;
  retention_count: number;
  destination: 'local' | 's3' | 'minio';
}

export type BackupConfig = Step11Body;

const enc = encodeURIComponent;

/** `/permissions`, `/listening-groups`, `/boundaries*`, `/audit-log*`, `/retention-policies`, `/persons/{id}/data-requests`. */
export function systemEndpoints(r: ApiClient['request']) {
  return {
    permissions: {
      get: (signal?: AbortSignal) => r<PermissionsPage>('/permissions', { signal }),
      patch: (body: PermissionPatchBody) => r<PermissionsPage>('/permissions', { method: 'PATCH', body }),
    },
    listeningGroups: (signal?: AbortSignal) => r<ListeningGroup[]>('/listening-groups', { signal }),
    boundaries: {
      list: (signal?: AbortSignal) => r<Boundary[]>('/boundaries', { signal }),
      patch: (code: string, body: BoundaryPatchBody) => r<Boundary>(`/boundaries/${enc(code)}`, { method: 'PATCH', body }),
    },
    systemAuditLog: {
      list: (q: SystemAuditQuery = {}, signal?: AbortSignal) => r<AuditPage>('/audit-log', { query: q as Record<string, string | number | undefined>, signal }),
      /** CSV — `data.manage` + PIN (`data.export`), cùng khuôn `raw.exportCsv`. */
      exportCsv: (q: Omit<SystemAuditQuery, 'cursor' | 'limit'> = {}) =>
        r<string>('/audit-log/export', { query: q as Record<string, string | undefined>, responseType: 'text' }),
    },
    retentionPolicies: {
      list: (signal?: AbortSignal) => r<RetentionPolicy[]>('/retention-policies', { signal }),
      patch: (body: RetentionPatchBody) => r<RetentionPolicy[]>('/retention-policies', { method: 'PATCH', body }),
    },
    personDataRequests: {
      create: (personId: string, kind: DataRequestKind) =>
        r<DataRequestResult>(`/persons/${enc(personId)}/data-requests`, { method: 'POST', body: { kind } }),
      list: (personId: string, signal?: AbortSignal) => r<DataRequestRecord[]>(`/persons/${enc(personId)}/data-requests`, { signal }),
    },
  };
}
