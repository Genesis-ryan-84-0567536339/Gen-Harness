/** Presentation logic for MCP Hub — cùng khuôn `apiModel.ts`/`pluginsModel.ts`. */
import { ApiError, type HubLinkStatus, type McpCallOutcome, type McpTool, type McpTransport } from '@gen-harness/contracts';
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

/** Thẻ Gen-hub (v0.1.26) — trạng thái liên kết. */
export const HUB_STATUS_LABEL: Record<HubLinkStatus, string> = {
  off: 'Đang tắt',
  ok: 'Đang nối',
  expiring: 'Token sắp hết hạn',
  expired: 'Token hết hạn',
  error: 'Lỗi kết nối',
};

export function hubStatusTone(s: HubLinkStatus): string {
  if (s === 'ok') return OK;
  if (s === 'expiring') return WARN;
  if (s === 'expired' || s === 'error') return BAD;
  return N5;
}

/** `YYYY-MM-DD` (ô ngày) → ISO cuối ngày giờ VN; rỗng → null. */
export function expiryToIso(day: string): string | null {
  return day ? `${day}T23:59:00+07:00` : null;
}

export function isoToDay(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** v0.1.39 (F-31): câu cố định khi máy chủ chặn Gen-hub ở mạng công cộng (`MCP_NETWORK_BLOCKED`). */
export const PUBLIC_NET_HINT = "Bật 'Cho phép Gen-hub ở mạng công cộng' ngay trong thẻ này.";

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.lan', '.internal', '.home.arpa'];

function privateIpv4(host: string): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (host === '0.0.0.0') return true;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function privateIpv6(host: string): boolean | null {
  if (!host.includes(':')) return null;
  if (host === '::1' || host === '::') return true;
  // ::ffff:a.b.c.d (URL chuẩn hoá thành ::ffff:xxxx:yyyy) — xét như IPv4, khớp `_unmap` của máy chủ.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return privateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`) ?? false;
  }
  const first = parseInt(host.split(':')[0] || '0', 16);
  // fc00::/7 (ULA), fe80::/10 (link-local).
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * v0.1.39 (F-31): địa chỉ là https VÀ trỏ ra Internet (không phải localhost/.local/.lan/.internal/.home.arpa, tên
 * một nhãn, IP riêng/loopback/link-local) → thẻ Gen-hub bật sẵn "Cho phép Gen-hub ở mạng công cộng". 100.64/10 coi
 * là công khai như `_is_public` của máy chủ.
 */
export function isPublicHttpsUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return false;
  const v4 = privateIpv4(host);
  if (v4 !== null) return !v4;
  const v6 = privateIpv6(host);
  if (v6 !== null) return !v6;
  if (host === 'localhost' || !host.includes('.')) return false;
  return !PRIVATE_SUFFIXES.some((s) => host.endsWith(s));
}
