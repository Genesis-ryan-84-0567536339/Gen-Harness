import { ApiError, PinCancelledError } from '@gen-harness/contracts';
import { AGY_ONLY_TEXT, MODEL_UNAVAILABLE_TEXT, agyOnlyReasons, detailToText, isAgyOnlyText } from './friendlyError';
import { DEFAULT_TZ, fmtDMClock } from './format';

const INTERNAL_FALLBACK_TITLE = 'Hệ thống gặp lỗi khi xử lý yêu cầu — đã ghi nhật ký';
const PIN_LOCKED_FALLBACK_TITLE = 'Mã PIN đang bị khoá do nhập sai nhiều lần';

/** v0.1.30: lỗi "không model nào chạy được" (503 MODEL_UNAVAILABLE, kể cả máy chủ cũ trả `detail={reasons}`). */
export function isModelUnavailable(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'MODEL_UNAVAILABLE';
}

/**
 * v0.1.38 (F-22): 503 MODEL_UNAVAILABLE vì chuỗi chỉ có Antigravity CLI (máy chủ trả AGY_ONLY_TITLE/AGY_ONLY_HINT).
 * Nhân viên: `reasons` đã lọc rỗng nhưng title vẫn đúng ⇒ xét title trước.
 */
export function isAgyOnlyUnavailable(e: unknown): boolean {
  if (!(e instanceof ApiError) || !isModelUnavailable(e)) return false;
  return isAgyOnlyText(e.problem.title) || agyOnlyReasons(e.reasons);
}

/** Câu cho lỗi "chỉ có Antigravity CLI": title + hướng dẫn của máy chủ (chuỗi), thiếu thì câu mặc định. */
export function agyOnlyText(e: unknown): string {
  if (!(e instanceof ApiError)) return AGY_ONLY_TEXT;
  const title = typeof e.problem.title === 'string' ? e.problem.title.trim() : '';
  const detail = detailToText(e.problem.detail).trim();
  if (isAgyOnlyText(title) && detail) return `${title}. ${detail}`;
  return isAgyOnlyText(title) ? title : AGY_ONLY_TEXT;
}

function titleOf(e: ApiError, fallback: string): string {
  const t = e.problem.title;
  return typeof t === 'string' && t.trim() ? t.trim() : fallback;
}

/**
 * User-facing message for an API error — luôn là chuỗi.
 * `tz`: múi giờ tổ chức (useOrgTimezone) để hiện giờ mở khoá PIN theo giờ địa phương.
 */
export function errorText(e: unknown, tz: string = DEFAULT_TZ): string {
  if (e instanceof PinCancelledError) return 'Đã huỷ — thao tác cần mã PIN.';
  if (e instanceof ApiError) {
    if (e.status === 0) return 'Không kết nối được máy chủ. Kiểm tra dịch vụ api rồi thử lại.';
    if (e.status === 403) return 'Vai trò của bạn không có quyền làm thao tác này.';
    if (isAgyOnlyUnavailable(e)) return agyOnlyText(e);
    if (isModelUnavailable(e)) return MODEL_UNAVAILABLE_TEXT;
    // v0.1.35: 500 INTERNAL — câu dễ hiểu (title) KÈM mã lỗi; `detail` chỉ có mã nên không được thay chỗ title.
    if (e.code === 'INTERNAL') {
      const id = (e.problem as { error_id?: unknown }).error_id;
      const title = titleOf(e, INTERNAL_FALLBACK_TITLE);
      return typeof id === 'string' && id ? `${title}. Mã lỗi ${id} — gửi mã này cho người hỗ trợ.` : title;
    }
    // v0.1.35: PIN_LOCKED — nói rõ PIN bị khoá, giờ mở khoá theo múi giờ tổ chức (không phải ISO UTC thô).
    if (e.code === 'PIN_LOCKED') {
      const until = e.lockedUntil;
      const when = until && !Number.isNaN(Date.parse(until)) ? fmtDMClock(until, tz) : null;
      return `${titleOf(e, PIN_LOCKED_FALLBACK_TITLE)}. ${when ? `Thử lại sau ${when}.` : 'Thử lại sau ít phút.'}`;
    }
    if (e.status === 422) {
      const errs = Object.values(e.fieldErrors).map(detailToText).filter(Boolean);
      if (errs.length) return errs.join(' ');
    }
    return detailToText(e.message) || 'Có lỗi không xác định.';
  }
  if (e instanceof Error) return detailToText(e.message) || 'Có lỗi không xác định.';
  return detailToText(e) || 'Có lỗi không xác định.';
}

/** Lý do kỹ thuật kèm theo (hiện trong "Chi tiết kỹ thuật"), null nếu không có. */
export function errorReasons(e: unknown): string | null {
  if (e instanceof ApiError && e.reasons.length) return e.reasons.join('; ');
  return null;
}
