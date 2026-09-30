import { ApiError, PinCancelledError } from '@gen-harness/contracts';
import { MODEL_UNAVAILABLE_TEXT, detailToText } from './friendlyError';

/** v0.1.30: lỗi "không model nào chạy được" (503 MODEL_UNAVAILABLE, kể cả máy chủ cũ trả `detail={reasons}`). */
export function isModelUnavailable(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'MODEL_UNAVAILABLE';
}

/** User-facing message for an API error — luôn là chuỗi. */
export function errorText(e: unknown): string {
  if (e instanceof PinCancelledError) return 'Đã huỷ — thao tác cần mã PIN.';
  if (e instanceof ApiError) {
    if (e.status === 0) return 'Không kết nối được máy chủ. Kiểm tra dịch vụ api rồi thử lại.';
    if (e.status === 403) return 'Vai trò của bạn không có quyền làm thao tác này.';
    if (isModelUnavailable(e)) return MODEL_UNAVAILABLE_TEXT;
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
