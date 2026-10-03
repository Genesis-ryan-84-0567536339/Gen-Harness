/**
 * Thang tự trị 0–6 (ARCHITECTURE §7) — NGUỒN DUY NHẤT phía web (header, Danh tính Agent, Hồ sơ sống, bước 9).
 * Phải khớp `gh.chassis.policy.LEVELS` (apps/api/gh/chassis/policy.py) — test chéo `autonomy-v0142.test.ts`.
 */
export const AUTONOMY_LEVELS = [
  'Chỉ ghi nhận',
  'Tóm tắt',
  'Chấm điểm + giải thích',
  'Gợi ý hành động',
  'Soạn sẵn chờ duyệt',
  'Tự làm việc thấp rủi ro',
  'Tự làm việc đã whitelist',
] as const;

/** Mức cao nhất của thang (0–6). */
export const AUTONOMY_MAX = 6;

/** Nhãn của một mức; `null` khi mức nằm ngoài thang hoặc không phải số nguyên. */
export function autonomyLabel(level: number): string | null {
  if (!Number.isInteger(level) || level < 0 || level > AUTONOMY_MAX) return null;
  return AUTONOMY_LEVELS[level] ?? null;
}
