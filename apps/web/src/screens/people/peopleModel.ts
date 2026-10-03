/** Presentation helpers dùng chung cho 2 màn của cụm Con người & Chất lượng. */
import type { CareScenarioStatus, PeopleReviewFull, ReviewBoard, Trend } from '@gen-harness/contracts';
// F-38 (v0.1.43): định nghĩa duy nhất ở lib/format.ts — re-export để các màn không phải đổi import.
export { initialsOf, fmtVnd } from '../../lib/format';

export const OK = 'var(--color-ok)';
export const WARN = 'var(--color-warn)';
export const BAD = 'var(--color-bad)';
export const N4 = 'var(--color-neutral-400)';
export const N5 = 'var(--color-neutral-500)';

export const BOARD_LABEL: Record<ReviewBoard, string> = {
  employee: 'Nhân viên',
  customer: 'Khách hàng',
  candidate: 'Ứng viên',
  student: 'Học viên',
};
export const REVIEW_BOARD_LIST: ReviewBoard[] = ['employee', 'customer', 'candidate', 'student'];

export function scoreTone(score: number): string {
  return score >= 75 ? OK : score >= 55 ? WARN : BAD;
}
export const TREND_ICON: Record<string, string> = { up: 'ph ph-trend-up', down: 'ph ph-trend-down', flat: 'ph ph-minus' };
export const TREND_LABEL: Record<string, string> = { up: 'tăng', down: 'giảm', flat: 'đi ngang' };
export function trendTone(t: Trend | null): string {
  return t === 'up' ? OK : t === 'down' ? BAD : N4;
}

/** "2026-09-17" → "17/09" — period là ngày thô (không giờ), không cần đổi múi giờ. */
function shortDate(d: string): string {
  const [, mm, dd] = d.split('-');
  return mm && dd ? `${dd}/${mm}` : d;
}
export function fmtPeriod(start: string, end: string): string {
  return `${shortDate(start)} – ${shortDate(end)}`;
}

/** Cùng ngưỡng lưới phản hồi PLAN §3.12: <15 nhanh (OK) · 15–60 vừa (WARN) · >60 chậm (BAD). */
export function minuteBandTone(minutes: number): string {
  return minutes > 60 ? BAD : minutes >= 15 ? WARN : OK;
}

export const SCENARIO_LABEL: Record<CareScenarioStatus, string> = { won: 'Thắng', lost: 'Mất' };
export const ISSUE_KIND_LABEL: Record<string, string> = {
  broken_promise: 'Hứa rồi quên',
  abandoned_customer: 'Khách bị bỏ rơi',
};

/**
 * v0.1.42: cách một người thành "nhân viên" (core.persons.person_type = 'staff') — chưa có ô sửa ở hồ sơ, chỉ qua
 * Quy tắc sàng lọc. Dùng ở Đội ngũ và ở trạng thái trống của Đánh giá con người / Chất lượng chăm sóc.
 */
export const STAFF_HOWTO =
  'Một người thành nhân viên khi có loại "staff": tạo quy tắc ở Nâng cao › Tầng dữ liệu › Quy tắc sàng lọc với kết quả "person_type = staff" cho tin của nhân viên.';

/**
 * v0.1.45 (F-60): nhãn cờ 'Đáng ngờ' của một dòng điểm — null khi không gắn cờ. `title` là lý do ngắn từ máy chủ
 * (không chứa nguyên tin); thiếu lý do thì dùng câu mặc định.
 */
export const SUSPICIOUS_FALLBACK =
  'Có tin giống lệnh cho AI hoặc xin điểm — Sếp xem chứng cứ trước khi dùng điểm này.';
export function suspiciousLabel(item: Pick<PeopleReviewFull, 'suspicious' | 'suspicious_reason'>): { text: string; title: string } | null {
  if (!item.suspicious) return null;
  return { text: 'Đáng ngờ', title: withStop(item.suspicious_reason?.trim() || SUSPICIOUS_FALLBACK) };
}

/** Lý do từ máy chủ cũ có thể thiếu dấu chấm cuối — thêm vào để câu ghép phía sau không dính liền. */
export function withStop(s: string): string {
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}
