/** Presentation logic for MCP Hub — cùng khuôn `apiModel.ts`/`pluginsModel.ts`. */
import { ApiError, type McpCallOutcome, type McpTool, type McpTransport } from '@gen-harness/contracts';
import { errorText } from '../../lib/errorText';

export const OK = 'var(--color-ok)';
export const WARN = 'var(--color-warn)';
export const BAD = 'var(--color-bad)';
export const ACC3 = 'var(--color-accent-300)';
export const N5 = 'var(--color-neutral-500)';

export const TRANSPORT_LABEL: Record<McpTransport, string> = {
  stdio: 'stdio',
  'http+sse': 'HTTP + SSE',
  streamable_http: 'Streamable HTTP',
};

export function healthLabel(h: string): string {
  if (h === 'healthy') return 'Đang chạy';
  if (h === 'blocked') return 'Bị chặn mạng';
  if (h === 'error') return 'Lỗi kết nối';
  return 'Chưa rõ';
}

export function healthTone(h: string): string {
  if (h === 'healthy') return OK;
  if (h === 'error' || h === 'blocked') return BAD;
  return N5;
}

export const ACCESS_LABEL: Record<McpTool['access'], string> = {
  read: 'Chỉ đọc',
  write: 'Có ghi — cần Sếp duyệt',
};

export const OUTCOME_LABEL: Record<McpCallOutcome, string> = {
  ok: 'OK',
  held_for_approval: 'Chờ duyệt',
  blocked: 'Bị chặn',
  error: 'Lỗi',
};

export function outcomeTone(o: McpCallOutcome): string {
  if (o === 'ok') return OK;
  if (o === 'held_for_approval') return WARN;
  return BAD;
}

export function fmtLatency(ms: number | null): string {
  return ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * `errorText()` dùng chung đổi MỌI lỗi 403 thành "Vai trò của bạn không có quyền làm thao tác này" — đúng cho
 * hầu hết màn (thiếu quyền RBAC) nhưng SAI cho lượt gọi tool MCP bị chặn (khoá cứng #4 cũng trả 403, kèm lý do
 * cụ thể ở `detail`, vd "Bị chặn: tool chưa được Owner mở" — đây là thông tin nghiệp vụ phải hiện đúng, không
 * phải lỗi phân quyền). Mã lỗi `MCP_*` giữ nguyên message gốc; còn lại rơi về `errorText()` như thường.
 */
export function mcpErrorText(e: unknown): string {
  if (e instanceof ApiError && e.code.startsWith('MCP_')) return e.message;
  return errorText(e);
}
