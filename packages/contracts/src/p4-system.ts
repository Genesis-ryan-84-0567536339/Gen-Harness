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

// ── Trình thiết lập bước 8–9 + việc thiết lập tiếp ───────────────────────────

export interface Step8Body {
  name: string;
  role_desc: string;
  voice?: string;
  speak_when?: string;
  template?: string | null;
  try_message: string;
}

export interface Step8Agent {
  id: string;
  name: string;
  try_reply: string | null;
  /** Câu chữ cho người đọc. Máy chủ ≤ v0.1.29 có thể trả đối tượng `{reasons}` — web phải qua `friendlyError`. */
  try_error: string | null;
  /** v0.1.30: mã lỗi (vd `MODEL_UNAVAILABLE`) + lý do kỹ thuật. */
  try_error_code?: string | null;
  try_reasons?: string[];
}

export interface Step9Body {
  autonomy_level: 3 | 4;
  ack_boundaries: boolean;
}

/** `GET /setup/follow-up` — bước tuỳ chọn chưa xong trong trình thiết lập; `done` suy từ dữ liệu thật. */
export interface SetupFollowUpItem {
  n: number;
  key: string;
  title: string;
  /** Trạng thái trong trình thiết lập; `done` bên dưới còn tính cả dữ liệu thật làm ở Console. */
  status: 'todo' | 'doing' | 'skipped' | 'done';
  done: boolean;
}

/** `GET/POST /system/update` — nút "Cập nhật ngay" (genh trên máy chủ làm việc thật, xem gh/system_api/update.py). */
export type SystemUpdateState = 'idle' | 'requested' | 'running' | 'done' | 'failed' | 'stalled';
export interface SystemUpdate {
  /** Phiên bản đang chạy (genh ghi vào hộp thư); null ở dev/test. */
  current: string | null;
  latest: string | null;
  update_available: boolean;
  /** Cơ chế nhận yêu cầu trên máy chủ (systemd/cron/launchd); null ⇒ Owner tự chạy lệnh một lần. */
  updater: string | null;
  /** Có hộp thư với máy chủ (cài bằng genh) hay không. */
  linked: boolean;
  can_request: boolean;
  state: SystemUpdateState;
  message: string | null;
  from: string | null;
  to: string | null;
  started_at: string | null;
  finished_at: string | null;
  requested_at: string | null;
  release_url: string | null;
  release_notes: string | null;
  /**
   * v0.1.33: lúc bản `latest` thành bản chính thức (ISO — dấu promote trong ghi chú Release, không có thì
   * published_at); lịch tự cập nhật đêm (~03:00) chỉ cài bản đã là bản chính thức ≥ 24 giờ. null = không rõ.
   */
  published_at?: string | null;
  /** v0.1.30: lần hỏi GitHub gần nhất thành công (ISO); null = chưa hỏi được. */
  checked_at?: string | null;
  /** v0.1.30: `POST /system/update/check` bị giới hạn (≤ 1 lần / 30 giây) — trả kết quả đang đệm. */
  throttled?: boolean;
}

/** `GET /system/backups` (v0.1.20, gh/system_api/backups.py) — Điều khiển hệ thống › Dữ liệu & lưu trữ. */
export type BackupTrigger = 'manual' | 'scheduled' | 'pre-update' | 'pre-restore' | 'pre-import';
export interface BackupItem {
  /** Khoá ObjectStore, ví dụ `backups/20260928T020000Z-1a2b3c4d.pgcustom.enc`. */
  key: string;
  taken_at: string;
  size_bytes: number;
  /** Nguồn tạo; null với bản ghi trước v0.1.20. */
  trigger: BackupTrigger | null;
  encrypted: boolean;
  key_id: 'backup' | 'master';
}
export type BackupJobState = 'queued' | 'running' | 'done' | 'failed' | 'stalled';
export interface BackupJob {
  id?: string;
  state: BackupJobState;
  requested_at?: string;
  started_at?: string;
  finished_at?: string;
  key?: string;
  message?: string | null;
}
export type RestoreState = 'idle' | 'requested' | 'running' | 'done' | 'failed' | 'stalled';
export interface BackupRestoreStatus {
  /** Máy chủ có watcher nhận yêu cầu khôi phục (genh ≥ v0.1.20). */
  can_request: boolean;
  state: RestoreState;
  key: string | null;
  /** Bản sao lưu an toàn genh chụp ngay trước khi khôi phục (đường lui). */
  safety_key: string | null;
  message: string | null;
  started_at: string | null;
  finished_at: string | null;
  requested_at: string | null;
}
export interface BackupSchedule {
  frequency: 'daily' | 'weekly' | 'monthly';
  time_of_day: string;
}
export interface BackupsPage {
  items: BackupItem[];
  /** null ⇒ chưa đặt lịch (bỏ qua bước 11). */
  schedule: BackupSchedule | null;
  timezone: string;
  retention: { daily: number; weekly: number; monthly: number; recent_hours: number };
  job: BackupJob | null;
  restore: BackupRestoreStatus;
}

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
    backups: {
      list: (signal?: AbortSignal) => r<BackupsPage>('/system/backups', { signal }),
      runNow: () => r<BackupsPage>('/system/backups', { method: 'POST' }),
      /** Tệp ĐÃ MÃ HOÁ — chỉ Owner, cần PIN (`backup.download`). */
      download: (key: string) => r<Blob>('/system/backups/download', { query: { key }, responseType: 'blob' }),
      /** Chỉ Owner, cần PIN (`backup.restore`) + gõ đúng "KHÔI PHỤC". */
      restore: (key: string, confirm: string) => r<BackupsPage>('/system/backups/restore', { method: 'POST', body: { key, confirm } }),
      schedule: (body: BackupSchedule) => r<BackupsPage>('/system/backups/schedule', { method: 'PUT', body }),
    },
    systemUpdate: {
      get: (signal?: AbortSignal) => r<SystemUpdate>('/system/update', { signal }),
      request: () => r<SystemUpdate>('/system/update', { method: 'POST' }),
      /** v0.1.30: "Kiểm tra bản mới" — hỏi GitHub ngay, bỏ qua bộ đệm (≤ 1 lần / 30 giây). */
      check: () => r<SystemUpdate>('/system/update/check', { method: 'POST' }),
    },
    personDataRequests: {
      create: (personId: string, kind: DataRequestKind) =>
        r<DataRequestResult>(`/persons/${enc(personId)}/data-requests`, { method: 'POST', body: { kind } }),
      list: (personId: string, signal?: AbortSignal) => r<DataRequestRecord[]>(`/persons/${enc(personId)}/data-requests`, { signal }),
    },
  };
}
