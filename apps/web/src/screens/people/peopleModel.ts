/** Presentation helpers dùng chung cho 2 màn của cụm Con người & Chất lượng. */
import type { CareScenarioStatus, ReviewBoard, Trend } from '@gen-harness/contracts';

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

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[parts.length - 2][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
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

const VND = new Intl.NumberFormat('vi-VN');
export function fmtVnd(n: number | null): string {
  return n === null ? '—' : `${VND.format(n)} ₫`;
}
