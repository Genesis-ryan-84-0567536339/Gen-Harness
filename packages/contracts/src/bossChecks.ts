/**
 * Hợp đồng v0.1.39 (F-74) — "Việc Sếp cần làm" (`/guide/viec-sep`): 5 dòng kết nối chạy thật, mỗi lần bấm là một lần
 * kiểm và KẾT QUẢ ĐƯỢC LƯU LẠI ở máy chủ (`ops.boss_checks`) — Claude tự đọc qua `GET /boss-checks`, Sếp không phải
 * chụp màn hình. CHỈ Owner (vai trò khác 403). Lỗi nghiệp vụ vẫn trả 200 với `status: 'fail'` + `error_code`.
 */
import type { ApiClient } from './client';

/** `agy_login` / `claude_login` do luồng đăng nhập CLI tự ghi — không chạy được bằng `run`. */
export type BossCheckKey = 'hub' | 'facebook' | 'agy_login' | 'agy_call' | 'agy_switch' | 'claude_login' | 'claude_call' | 'jev';

export type BossCheckStatus = 'pass' | 'fail' | 'pending';

export interface BossCheck {
  key: BossCheckKey;
  status: BossCheckStatus;
  /** Mã lỗi thống nhất (HUB_TOKEN_REJECTED, SOCIAL_NO_SESSION, AGY_ACCOUNT_MISMATCH…) — null khi đạt/đang chạy. */
  error_code: string | null;
  /** Câu tiếng Việt cho Sếp (đã lọc bí mật). */
  message: string | null;
  detail: Record<string, string | number | boolean | null | string[] | Record<string, unknown>>;
  checked_at: string;
  /** Số lần đã chạy (agy_switch: số lần đổi qua lại). */
  runs: number;
  /** Tài khoản đang dùng (agy/claude) — Owner thấy email đầy đủ. */
  account?: string | null;
}

export interface BossRow {
  row: number;
  key: string;
  title: string;
  /** Dòng tuỳ chọn (Jev) — không tính vào `required_total`. */
  optional: boolean;
  checks: BossCheckKey[];
  done: boolean;
}

export interface BossOverview {
  rows: BossRow[];
  results: Record<BossCheckKey, BossCheck | null>;
  required_done: number;
  required_total: number;
}

export interface BossCheckRunBody {
  profile_id?: string;
  account_id?: string;
}

const enc = encodeURIComponent;

/** `GET /boss-checks`, `POST /boss-checks/{key}/run` (423 PIN_REQUIRED cho hub/agy_switch). */
export function bossChecksEndpoints(r: ApiClient['request']) {
  return {
    list: (signal?: AbortSignal) => r<BossOverview>('/boss-checks', { signal }),
    run: (key: BossCheckKey, body?: BossCheckRunBody) => r<BossCheck>(`/boss-checks/${enc(key)}/run`, { method: 'POST', body: body ?? {} }),
  };
}
