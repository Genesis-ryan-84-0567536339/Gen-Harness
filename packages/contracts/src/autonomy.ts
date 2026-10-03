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

/**
 * v0.1.43 (F-30) — giao diện chỉ cho chọn 3 mức; backend vẫn giữ thang 0–6 ở trên. Mức 5/6 chỉ đặt được trong khối
 * "Nâng cao" của `AutonomySelect` và hiện là `AUTONOMY_AUTO_LABEL` — TUYỆT ĐỐI không hiện thành "Soạn sẵn chờ duyệt".
 */
export const AUTONOMY_CHOICES = [
  { key: 'observe', label: 'Chỉ ghi nhận', level: 0, hint: 'Chỉ đọc và ghi lại, không gợi ý gì.' },
  { key: 'suggest', label: 'Gợi ý', level: 3, hint: 'Gợi ý việc nên làm, Sếp tự làm.' },
  { key: 'draft', label: 'Soạn sẵn chờ duyệt', level: 4, hint: 'Soạn sẵn tin trả lời; chỉ gửi khi Sếp duyệt.' },
] as const;

export type AutonomyChoiceKey = (typeof AUTONOMY_CHOICES)[number]['key'] | 'auto';

export const AUTONOMY_AUTO_LABEL = 'Tự làm (đặt ở Nâng cao)';

/** Nhóm hiển thị của một mức 0–6: 0–2 → Chỉ ghi nhận, 3 → Gợi ý, 4 → Soạn sẵn chờ duyệt, 5–6 → Tự làm; ngoài thang → null. */
export function autonomyChoice(level: number | null | undefined): { key: AutonomyChoiceKey; label: string } | null {
  if (level === null || level === undefined || !Number.isInteger(level) || level < 0 || level > AUTONOMY_MAX) return null;
  if (level >= 5) return { key: 'auto', label: AUTONOMY_AUTO_LABEL };
  const c = level <= 2 ? AUTONOMY_CHOICES[0] : level === 3 ? AUTONOMY_CHOICES[1] : AUTONOMY_CHOICES[2];
  return { key: c.key, label: c.label };
}

/** Phần thân PATCH cho mức tự trị: chỉ có `autonomy_level` khi Sếp đã chọn một mức KHÁC mức đang lưu. */
export function autonomyPatch(current: number | null, picked: number | null): { autonomy_level?: number } {
  if (picked === null || picked === current) return {};
  return { autonomy_level: picked };
}
