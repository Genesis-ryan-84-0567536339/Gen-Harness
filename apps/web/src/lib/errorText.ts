import { ApiError, PinCancelledError } from '@gen-harness/contracts';

/** User-facing message for an API error. */
export function errorText(e: unknown): string {
  if (e instanceof PinCancelledError) return 'Đã huỷ — thao tác cần mã PIN.';
  if (e instanceof ApiError) {
    if (e.status === 0) return 'Không kết nối được máy chủ. Kiểm tra dịch vụ api rồi thử lại.';
    if (e.status === 403) return 'Vai trò của bạn không có quyền làm thao tác này.';
    if (e.status === 422) {
      const errs = Object.values(e.fieldErrors);
      if (errs.length) return errs.join(' ');
    }
    return e.message;
  }
  return e instanceof Error ? e.message : 'Có lỗi không xác định.';
}
