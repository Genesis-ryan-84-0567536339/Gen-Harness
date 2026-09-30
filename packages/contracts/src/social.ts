/**
 * Hợp đồng v0.1.29 — Tài khoản mạng xã hội (Đợt D3 lát đầu, docs/design/gen-browser-agent.md §5.1; API
 * `apps/api/gh/social/routes.py`). CHỈ Owner. CHỈ ĐỌC: thông báo + danh sách hội thoại. Ghi (đăng/trả lời/nhắn) để
 * v0.1.30 qua đề xuất + PIN + permit.
 */
import type { ApiClient } from './client';

export type SocialAccountStatus = 'pending_login' | 'active' | 'needs_login' | 'paused' | 'revoked';
export type BrowserJobKind = 'login' | 'health' | 'read';
export type BrowserJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'halted' | 'cancelled';

export interface SocialPlatform {
  key: string;
  name: string;
  mode: 'browser' | 'api';
  read_kinds: string[];
  write_kinds: string[];
  /** Rủi ro nói bằng lời thường — hiện trong hộp chấp nhận rủi ro. */
  risk: string[];
  will_do: string[];
  wont_do: string[];
  risk_version: string;
}

export interface SocialPlatforms {
  items: SocialPlatform[];
  /** Luật cứng — không phải lựa chọn, luôn tắt (không tài khoản giả, không lách chống bot…). */
  hard_rules: string[];
  risk_version: string;
}

export interface SocialItem {
  kind: 'notification' | 'inbox';
  who: string | null;
  text: string;
  time: string | null;
  unread: boolean;
  link: string | null;
  /** Chữ giống lừa đảo / đòi mã / "bỏ qua chỉ dẫn" — vẫn chỉ là dữ liệu. */
  suspicious: boolean;
}

export interface BrowserJob {
  id: string;
  account_id: string;
  kind: BrowserJobKind;
  status: BrowserJobStatus;
  via: 'gen' | 'user' | 'schedule';
  error: string | null;
  error_text: string | null;
  result: {
    items?: SocialItem[];
    counts?: { notifications: number; inbox: number; unread: number; suspicious: number };
    pages?: number;
    logged_in?: boolean;
  } | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface SocialSchedule {
  enabled: boolean;
  times: string[];
}

export interface SocialAccount {
  id: string;
  platform: string;
  platform_name: string;
  mode: 'browser' | 'api';
  label: string;
  external_handle: string | null;
  status: SocialAccountStatus;
  pause_reason: string | null;
  has_session: boolean;
  session_updated_at: string | null;
  last_health: { ok: boolean; at: string; state: string } | null;
  risk_accepted_at: string | null;
  risk_version: string | null;
  schedule: SocialSchedule;
  daily_read_limit: number;
  last_read_at: string | null;
  created_at: string;
  active_job: BrowserJob | null;
}

export interface SocialStatus {
  halted: boolean;
  halted_at: string | null;
  worker: { version: string; at: string; running: number } | null;
  hard_rules: string[];
  limits: { reads_per_day_max: number; read_min_interval_minutes: number; quiet_hours: number[]; concurrency_per_account: number };
}

export interface SocialAccountCreate {
  platform: string;
  label: string;
  risk_version: string;
  accept_risk: boolean;
  accept_rules: boolean;
}

export interface SocialAccountPatch {
  label?: string;
  schedule?: SocialSchedule;
  daily_read_limit?: number;
}

export interface SocialLoginTicket {
  job_id: string;
  ticket: string;
  timeout_s: number;
}

/** WS `/api/v1/social/login/{ticket}`: máy chủ → trình duyệt. */
export type SocialLiveMessage =
  | { type: 'frame'; data: string; w: number | null; h: number | null }
  | { type: 'status'; state: string; message: string };

/** WS: trình duyệt → máy chủ (máy chủ lọc lại; phím đặc biệt theo danh sách cho phép). */
export type SocialLiveInput =
  | { type: 'mouse'; action: 'move' | 'down' | 'up' | 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { type: 'wheel'; dx: number; dy: number; x: number; y: number }
  | { type: 'key'; action: 'down' | 'up' | 'press'; key: string }
  | { type: 'text'; text: string }
  | { type: 'nav'; action: 'back' | 'reload' }
  | { type: 'done' }
  | { type: 'cancel' };

const enc = encodeURIComponent;

export function socialEndpoints(r: ApiClient['request']) {
  return {
    social: {
      status: (signal?: AbortSignal) => r<SocialStatus>('/social/status', { signal }),
      platforms: (signal?: AbortSignal) => r<SocialPlatforms>('/social/platforms', { signal }),
      accounts: {
        list: (signal?: AbortSignal) => r<{ items: SocialAccount[] }>('/social/accounts', { signal }),
        create: (body: SocialAccountCreate) => r<SocialAccount>('/social/accounts', { method: 'POST', body }),
        update: (id: string, body: SocialAccountPatch) =>
          r<SocialAccount>(`/social/accounts/${enc(id)}`, { method: 'PATCH', body }),
        remove: (id: string) => r<void>(`/social/accounts/${enc(id)}`, { method: 'DELETE' }),
        login: (id: string) => r<SocialLoginTicket>(`/social/accounts/${enc(id)}/login`, { method: 'POST' }),
        check: (id: string) => r<BrowserJob>(`/social/accounts/${enc(id)}/check`, { method: 'POST' }),
        read: (id: string) => r<BrowserJob>(`/social/accounts/${enc(id)}/read`, { method: 'POST', body: {} }),
        pause: (id: string) => r<SocialAccount>(`/social/accounts/${enc(id)}/pause`, { method: 'POST' }),
        resume: (id: string) => r<SocialAccount>(`/social/accounts/${enc(id)}/resume`, { method: 'POST' }),
        latest: (id: string, signal?: AbortSignal) =>
          r<{ job: BrowserJob | null }>(`/social/accounts/${enc(id)}/latest`, { signal }),
      },
      halt: () => r<SocialStatus>('/social/halt', { method: 'POST' }),
      release: () => r<SocialStatus>('/social/halt', { method: 'DELETE' }),
    },
  };
}
