/**
 * v0.1.40 (F-12): đổi `GET /system/offsite` (`OffsiteState`) thành chữ/tông cho thẻ "Bản sao ngoài máy" (Điều khiển hệ
 * thống › Dữ liệu & lưu trữ). Hàm thuần — test được; mọi giá trị trả ra là chuỗi/số/bool (không đưa object vào JSX).
 */
import { ApiError, type OffsiteState } from '@gen-harness/contracts';
import { DEFAULT_TZ, fmtDM, fmtDec, fmtHM } from '../../lib/format';

export const OFFSITE_KEY = ['system', 'offsite'] as const;

/** Quá 7 ngày chưa có bản sao ngoài máy ⇒ vàng; quá 30 ngày ⇒ đỏ (cùng ngưỡng sự cố offsite.stale của API). */
export const OFFSITE_STALE_DAYS = 7;
export const OFFSITE_BAD_DAYS = 30;
/** Yêu cầu nằm quá 15 phút mà máy chủ chưa nhận ⇒ "stalled" (cùng ngưỡng cập nhật/khôi phục). */
const STALL_MS = 15 * 60_000;
const DAY_MS = 24 * 3600 * 1000;

/** Chữ hiện trên thẻ cho từng mã lỗi genh (GH-EBxx) — dùng khi API không gửi `message`. */
export const OFFSITE_ERROR_TEXT: Record<string, string> = {
  'GH-EB00': 'Chưa chọn nơi lưu bản sao ngoài máy.',
  'GH-EB01': 'Chưa thấy ổ USB/NAS — hãy cắm ổ (hoặc mount NAS) vào máy chủ rồi thử lại.',
  'GH-EB02': 'Xuất gói dữ liệu chưa thành công — thử lại sau ít phút.',
  'GH-EB03': 'Gói vừa ghi không đọc lại được nên chưa tính là bản sao — thử lại, nếu vẫn lỗi hãy đổi ổ khác.',
  'GH-EB04': 'Không ghi được vào ổ ngoài — ổ có thể đầy, chỉ đọc hoặc bị rút ra giữa chừng.',
  'GH-EB05': 'Máy chủ đang cập nhật hoặc khôi phục — bản sao ngoài máy sẽ chạy lại sau.',
  'GH-EB06': 'Dịch vụ Gen-Harness chưa chạy nên chưa xuất được bản sao.',
  'GH-EB07': 'Nơi lưu không hợp lệ — phải là ổ USB/NAS khác ổ chính của máy chủ.',
};

/** Gợi ý đường dẫn TRÊN MÁY CHỦ (không phải máy đang mở Console). */
export const OFFSITE_PATH_HINTS: ReadonlyArray<{ os: string; example: string }> = [
  { os: 'Linux', example: '/media/<tên>/<ổ>' },
  { os: 'macOS', example: '/Volumes/<ổ>' },
  { os: 'Windows', example: 'E:\\GenBackup' },
  { os: 'NAS', example: 'thư mục NAS đã mount, vd /mnt/nas/gen' },
];

/** Số ngày (làm tròn xuống) từ `iso` tới `now`; null khi không có/không đọc được. */
export function ageDays(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

/** 1_288_490_189 → "1,2 GB"; 48_300_000 → "46,1 MB". */
export function fmtSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes >= GB) return `${fmtDec(bytes / GB, 1)} GB`;
  if (bytes >= MB) return `${fmtDec(bytes / MB, 1)} MB`;
  if (bytes >= KB) return `${fmtDec(bytes / KB, 1)} KB`;
  return `${Math.round(bytes)} B`;
}

/** "Mỗi Chủ nhật ~05:30" khi máy chủ đã cài lịch tuần (systemd/cron/launchd/schtasks); còn lại "Chưa bật lịch". */
export function offsiteScheduleText(schedule: string | null | undefined): string {
  return typeof schedule === 'string' && schedule.trim() ? 'Mỗi Chủ nhật ~05:30' : 'Chưa bật lịch';
}

/** Câu lỗi thân thiện: ưu tiên `message` của API (chuỗi), không có thì theo mã GH-EBxx. */
export function offsiteErrorText(code: string | null | undefined, message?: string | null): string {
  if (typeof message === 'string' && message.trim()) return message.trim();
  const c = typeof code === 'string' ? code.trim() : '';
  return (c && OFFSITE_ERROR_TEXT[c]) || 'Lần sao lưu ra ổ ngoài gần nhất chưa thành công.';
}

export type OffsiteTone = 'none' | 'warn' | 'bad';

export interface OffsiteView {
  /** Dòng chính. */
  headline: string;
  hasCopy: boolean;
  days: number | null;
  stale: boolean;
  /** Hộp cảnh báo: 'none' = không cảnh báo; 'warn' vàng (> 7 ngày / chưa có); 'bad' đỏ (> 30 ngày). */
  tone: OffsiteTone;
  warning: string | null;
  /** Lỗi lần gần nhất (chuỗi thân thiện) + mã kỹ thuật (chuỗi) cho "Chi tiết kỹ thuật"; null = không lỗi. */
  error: { text: string; code: string } | null;
  dest: string;
  schedule: string;
  keyId: string;
}

const ERROR_STATES = new Set(['failed', 'not_mounted', 'not_configured']);

/** Toàn bộ chữ của thẻ "Bản sao ngoài máy" — tuổi tính lại ở trình duyệt (API có `age_days` làm dự phòng). */
export function offsiteView(o: OffsiteState, now = Date.now(), tz = DEFAULT_TZ): OffsiteView {
  const fromIso = ageDays(o.last_success_at, now);
  const days = fromIso ?? (o.last_success_at && typeof o.age_days === 'number' ? Math.floor(o.age_days) : null);
  const hasCopy = !!o.last_success_at;
  const stale = !hasCopy || (days != null && days > OFFSITE_STALE_DAYS) || (o.stale === true && days == null);
  const tone: OffsiteTone = !stale ? 'none' : days != null && days > OFFSITE_BAD_DAYS ? 'bad' : 'warn';

  let headline = 'Chưa có bản sao ngoài máy';
  if (hasCopy) {
    const ago = days == null ? '' : days === 0 ? ' (hôm nay)' : ` (${days} ngày trước)`;
    const size = fmtSize(o.last_size_bytes);
    const parts = [`Bản sao ngoài máy gần nhất: ${fmtDM(o.last_success_at, tz)} ${fmtHM(o.last_success_at, tz)}${ago}`];
    if (size) parts.push(size);
    if (o.verified) parts.push('đã kiểm đọc lại được');
    headline = parts.join(' · ');
  }

  const warning = !stale
    ? null
    : hasCopy
      ? `Hỏng ổ đĩa là mất hết dữ liệu — đã ${days ?? 'nhiều'} ngày chưa có bản sao ngoài máy. Cắm ổ USB/NAS rồi bấm "Sao lưu ra ổ ngoài ngay".`
      : o.configured
        ? 'Hỏng ổ đĩa là mất hết dữ liệu — chưa có bản sao nào nằm ngoài máy chủ. Cắm ổ USB/NAS rồi bấm "Sao lưu ra ổ ngoài ngay".'
        : 'Hỏng ổ đĩa là mất hết dữ liệu — chưa có bản sao nào nằm ngoài máy chủ. Cắm ổ USB/NAS vào máy chủ rồi chọn nơi lưu bản sao ngoài máy.';

  const code = typeof o.error_code === 'string' ? o.error_code.trim() : '';
  const failed = ERROR_STATES.has(String(o.state)) || (!!code && o.state !== 'ok' && o.state !== 'running');
  // Chưa chọn nơi lưu không phải "lỗi" — cảnh báo phía trên đã nói; chỉ báo lỗi khi đã cấu hình.
  const error = failed && (o.configured || (code && code !== 'GH-EB00')) ? { text: offsiteErrorText(code, o.message), code: code || String(o.state) } : null;

  return {
    headline,
    hasCopy,
    days,
    stale,
    tone,
    warning,
    error,
    dest: typeof o.dest === 'string' && o.dest.trim() ? o.dest : '',
    schedule: offsiteScheduleText(o.schedule),
    keyId: typeof o.key_id === 'string' ? o.key_id : '',
  };
}

export type OffsiteRequestView =
  | { kind: 'none' }
  | { kind: 'waiting' | 'running' | 'stalled'; text: string };

/** Yêu cầu Console gửi genh (chọn nơi lưu / chạy ngay / tắt): "Đang chờ máy chủ nhận…" → đang chạy → (quá 15 phút) stalled. */
export function offsiteRequestView(o: OffsiteState | undefined, now = Date.now()): OffsiteRequestView {
  if (!o) return { kind: 'none' };
  const r = o.request;
  const what = r?.action === 'set' ? 'đổi nơi lưu' : r?.action === 'disable' ? 'tắt bản sao ngoài máy' : 'sao lưu ra ổ ngoài';
  if (o.state === 'running' || r?.state === 'running') return { kind: 'running', text: 'Đang sao lưu ra ổ ngoài — có thể mất vài phút…' };
  if (r?.state === 'stalled') {
    return { kind: 'stalled', text: `Máy chủ chưa nhận yêu cầu ${what} sau 15 phút — trình nhận yêu cầu trên máy chủ có thể chưa chạy.` };
  }
  if (r?.state === 'requested') {
    const t = r.requested_at ? Date.parse(r.requested_at) : NaN;
    if (Number.isFinite(t) && now - t > STALL_MS) {
      return { kind: 'stalled', text: `Máy chủ chưa nhận yêu cầu ${what} sau 15 phút — trình nhận yêu cầu trên máy chủ có thể chưa chạy.` };
    }
    return { kind: 'waiting', text: `Đang chờ máy chủ nhận yêu cầu ${what}…` };
  }
  return { kind: 'none' };
}

/** Hỏi lại mỗi 5 giây khi đang chờ máy chủ nhận / đang chạy. */
export function offsiteBusy(o: OffsiteState | undefined): boolean {
  return !!o && (o.request?.state === 'requested' || o.request?.state === 'running' || o.state === 'running');
}

/** Lệnh Owner tự chạy trên máy chủ: 409 OFFSITE_UNAVAILABLE mang `manual_command` (cấp ngoài hoặc trong `detail`). */
export function manualCommandOf(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const p = e.problem as unknown as Record<string, unknown>;
  const d = p.detail;
  const raw = typeof p.manual_command === 'string' ? p.manual_command : d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>).manual_command : null;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** Câu thân thiện cho các mã lỗi API của bản sao ngoài máy; null = dùng errorText chung. */
export function offsiteApiErrorText(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  switch (e.code) {
    case 'OFFSITE_UNAVAILABLE':
      return 'Máy chủ chưa nhận được yêu cầu từ Console (trình nhận yêu cầu chưa bật). Chạy lệnh dưới đây một lần trên máy chủ.';
    case 'OFFSITE_IN_PROGRESS':
      return 'Đang sao lưu ra ổ ngoài — chờ xong rồi thử lại.';
    case 'OFFSITE_KEY_MISSING':
      return 'Máy chủ chưa có Khoá khôi phục — chạy "genh offsite" trên máy chủ một lần để tạo.';
    case 'PORTABLE_IN_PROGRESS':
      return 'Đang chuẩn bị một gói mang đi khác — chờ tải xong rồi thử lại.';
    case 'UPDATE_IN_PROGRESS':
      return 'Máy chủ đang cập nhật — thử lại sau khi cập nhật xong.';
    case 'RESTORE_IN_PROGRESS':
      return 'Máy chủ đang khôi phục dữ liệu — thử lại sau khi khôi phục xong.';
    default:
      return null;
  }
}

/** Mã lỗi (chuỗi) cho "Chi tiết kỹ thuật". */
export function errorCodeOf(e: unknown): string {
  return e instanceof ApiError ? `${e.code} (HTTP ${e.status})` : '';
}

/**
 * Tên tệp gói mang đi (chỉ để gợi ý — máy chủ gửi Content-Disposition riêng). Ngày theo giờ máy đang mở Console.
 */
export function portableName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `gen-harness-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.ghbundle`;
}

const FRAME_ID = 'gh-portable-frame';

/**
 * "Tải gói mang đi": trình duyệt tự tải bằng điều hướng một khung ẩn tới URL (gói có thể rất lớn — KHÔNG fetch→blob vào
 * bộ nhớ). Tệp đính kèm thì trình duyệt ghi thẳng xuống đĩa; nếu máy chủ trả lỗi JSON (409/423…) thì khung tải được
 * trang lỗi ⇒ đọc mã lỗi để báo thân thiện. Khung giữ lại trên trang (gỡ sớm có thể cắt ngang lượt tải).
 */
export function startPortableDownload(url: string, onError: (code: string, title: string) => void): void {
  document.getElementById(FRAME_ID)?.remove();
  const frame = document.createElement('iframe');
  frame.id = FRAME_ID;
  frame.title = 'Tải gói mang đi';
  frame.hidden = true;
  frame.setAttribute('aria-hidden', 'true');
  frame.dataset.testid = 'portable-frame';
  frame.addEventListener('load', () => {
    let text = '';
    try {
      text = frame.contentDocument?.body?.textContent ?? '';
    } catch {
      return;
    }
    if (!text.trim().startsWith('{')) return;
    try {
      const p = JSON.parse(text) as { code?: unknown; title?: unknown };
      if (typeof p.code === 'string') onError(p.code, typeof p.title === 'string' ? p.title : '');
    } catch {
      /* không phải JSON — bỏ qua */
    }
  });
  frame.src = url;
  document.body.appendChild(frame);
}
