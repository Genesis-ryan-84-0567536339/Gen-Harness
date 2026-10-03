/**
 * Hợp đồng v0.1.44 (F-4b) — "Gói chẩn đoán cho người hỗ trợ" (Trợ giúp, CHỈ Owner): Console nhờ genh trên máy chủ
 * chạy `genh doctor` (qua `run/request/doctor.json`), genh đóng gói zip ĐÃ LỌC mật khẩu/khoá/token; Sếp tải về gửi
 * người hỗ trợ. genh cũ (không hỗ trợ) ⇒ `supported=false`, Console hiện lệnh để Sếp chạy tay trên máy chủ.
 *
 * Kèm hợp đồng `POST /client-errors` (web báo lỗi giao diện về máy chủ, không cần đăng nhập).
 */
import type { ApiClient } from './client';

export type DiagnosticsStateName = 'idle' | 'pending' | 'running' | 'done' | 'failed';

export interface DiagnosticsState {
  supported: boolean;
  state: DiagnosticsStateName;
  /** 16 hex — để đối chiếu nhật ký genh/api. */
  request_id: string | null;
  requested_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  file_name: string | null;
  size_bytes: number | null;
  sha256: string | null;
  error_code: string | null;
  message: string | null;
  /** Lệnh chạy tay trên máy chủ ("genh doctor"). */
  command: string;
}

/** `GET /system/diagnostics/download` (PIN `diagnostics.download`) — tải bằng điều hướng trình duyệt (cùng gốc). */
export const DIAGNOSTICS_DOWNLOAD_URL = '/api/v1/system/diagnostics/download';

/** `GET /system/diagnostics`, `POST /system/diagnostics` (PIN; 202; 409 DIAG_UNSUPPORTED|DIAG_BUSY). */
export function diagnosticsEndpoints(r: ApiClient['request']) {
  return {
    getDiagnostics: (signal?: AbortSignal) => r<DiagnosticsState>('/system/diagnostics', { signal }),
    requestDiagnostics: () => r<DiagnosticsState>('/system/diagnostics', { method: 'POST', body: {} }),
    diagnosticsDownloadUrl: DIAGNOSTICS_DOWNLOAD_URL,
    /** Tải tệp zip (vài MB) qua apiClient ⇒ 423 PIN tự mở hộp PIN; 404 DIAG_NOT_READY, 409 DIAG_FILE_UNSAFE. */
    downloadDiagnostics: () => r<Blob>('/system/diagnostics/download', { responseType: 'blob' }),
  };
}

/** `POST /client-errors` (không cần đăng nhập, miễn SetupGate) → 202 `{ok, request_id}`; 429 CLIENT_ERRORS_RATE_LIMITED. */
export interface ClientErrorBody {
  /** `ERR-XXXXX-YYYY` — mã hiện cho người dùng. */
  error_id: string;
  message: string;
  name?: string;
  stack?: string;
  component_stack?: string;
  path: string;
  request_id?: string;
  app_version?: string;
}

export const CLIENT_ERRORS_URL = '/api/v1/client-errors';
