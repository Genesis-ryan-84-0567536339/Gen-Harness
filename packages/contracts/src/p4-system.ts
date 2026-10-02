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
export type SystemUpdateStalledReason = 'not_picked_up' | 'process_gone' | null;
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
  /**
   * v0.1.37 (F-34): lý do 'stalled' — `not_picked_up` = yêu cầu nằm quá 15 phút (watcher không chạy); `process_gone` =
   * 'running' mà tiến trình genh đã chết (máy khởi động lại / quá 60 phút không còn nhịp sống). null khi không 'stalled';
   * thiếu ở api cũ.
   */
  stalled_reason?: SystemUpdateStalledReason;
  /**
   * v0.1.37: yêu cầu đang xếp hàng sau một lần cập nhật/khôi phục khác đang chạy trên máy chủ (vd lịch đêm — genh còn
   * nhịp sống); khi đó yêu cầu nằm quá 15 phút vẫn là 'requested', không phải `not_picked_up`. Thiếu ở api cũ.
   */
  host_busy?: boolean;
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
  /**
   * v0.1.33: lịch tự cập nhật đêm đang bật (genh ghi vào genh.json khi cài / `genh auto-update enable|disable`);
   * null = genh cũ chưa ghi hoặc không đọc được — Console không hứa "Tự cài".
   */
  auto_update_enabled?: boolean | null;
  /**
   * v0.1.34: bản đã lỗi ở lần cập nhật trước và đã quay về bản cũ (genh ghi run/update-blocked.json) — lịch đêm không
   * tự cài lại đúng bản này; null = không có bản nào bị chặn.
   */
  blocked_version?: string | null;
  /**
   * v0.1.34: `rollback_failed` trong run/update-blocked.json của bản bị chặn — tự quay về bản cũ CŨNG thất bại, máy cần
   * xử lý tay. null = không có bản bị chặn (hoặc api cũ) — Console rơi về dò chữ trong thông điệp genh.
   */
  blocked_rollback_failed?: boolean | null;
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

/**
 * v0.1.36 (F-6): `GET /system/health` (quyền `system.read`; KHÔNG thuộc `/ready` — genh dùng `/ready` để quyết quay về
 * bản cũ). Tổng hợp sức khoẻ: Bộ xử lý nền (arq), Trình duyệt nền, hàng lỗi (DLQ), lịch chạy, sao lưu, cập nhật, ổ đĩa,
 * cộng các sự cố đang mở ở `ops.health_alerts` (`issues` — nguồn của dải "Cần Sếp xử lý" đầu Tổng quan). Mọi trường là
 * chuỗi/số/bool — web không bao giờ render object.
 */
export type HealthSeverity = 'bad' | 'warn';
export interface HealthIssue {
  /** Khoá khử trùng lặp, vd `channel.down:zalo`, `update.failed`. */
  key: string;
  /** Cùng `kind` của chuông: channel.down, model.auth_expired, update.failed, backup.stale, worker.silent, disk.low. */
  kind: string;
  severity: HealthSeverity;
  title: string;
  body: string;
  /** Đường dẫn trong Console để xử lý (vd `/system?tab=channels`); null = không có. */
  link: string | null;
  /** Nhãn nút, vd "Đăng nhập lại". */
  action: string;
  raised_at: string;
}
export interface SystemHealth {
  checked_at: string;
  overall: 'ok' | 'warn' | 'bad';
  worker: { state: 'ok' | 'silent' | 'unknown'; alive: boolean; last_seen_at: string | null; silent_minutes: number | null };
  browser: { state: 'ok' | 'silent' | 'off'; last_heartbeat_at: string | null };
  /** `stream` là tên stream gốc (không có `.dlq`). */
  queues: Array<{ stream: string; dlq: number }>;
  crons: Array<{ name: string; last_at: string | null; ok: boolean | null }>;
  /**
   * `frequency`/`stale_after` (v0.1.36): hạn sao lưu theo tần suất bước 11 — `stale_after` là chữ hiện cho Sếp ("36 giờ",
   * "một tuần", "một tháng"); null khi chưa cấu hình.
   */
  backup: {
    configured: boolean;
    latest_at: string | null;
    age_hours: number | null;
    stale: boolean;
    frequency?: 'daily' | 'weekly' | 'monthly' | null;
    stale_after?: string | null;
  };
  /** `failed` = lần cập nhật lỗi trong 24 giờ qua (cùng điều kiện thẻ cập nhật) — quá hạn thì false dù `state` vẫn 'failed'. */
  update: {
    state: SystemUpdateState | 'unknown' | string;
    stalled_reason?: SystemUpdateStalledReason;
    failed: boolean;
    blocked_version: string | null;
    finished_at: string | null;
  };
  disk: { state: 'ok' | 'low' | 'unknown'; free_bytes: number | null; min_bytes: number | null; checked_at: string | null };
  issues: HealthIssue[];
  /**
   * v0.1.37 (F-73): máy chủ có tự chạy lại Gen-Harness khi bật máy không (genh ghi run/autostart-status.json). Chỉ có
   * khi api có hộp thư với genh; 'warn' khi Docker chưa bật tự chạy hoặc thiếu linger (kèm sự cố host.autostart).
   */
  autostart?: {
    state: 'ok' | 'warn' | 'unknown';
    linger: 'yes' | 'no' | 'unknown' | 'not_applicable';
    linger_required: boolean | null;
    docker_enabled: 'yes' | 'no' | 'unknown' | 'not_applicable';
    docker_mode: 'system' | 'rootless' | 'desktop' | 'unknown';
    checked_at: string | null;
  };
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
    /** v0.1.36 (F-6): sức khoẻ hệ thống + sự cố cần Sếp xử lý. */
    systemHealth: {
      get: (signal?: AbortSignal) => r<SystemHealth>('/system/health', { signal }),
    },
    personDataRequests: {
      create: (personId: string, kind: DataRequestKind) =>
        r<DataRequestResult>(`/persons/${enc(personId)}/data-requests`, { method: 'POST', body: { kind } }),
      list: (personId: string, signal?: AbortSignal) => r<DataRequestRecord[]>(`/persons/${enc(personId)}/data-requests`, { signal }),
    },
  };
}
