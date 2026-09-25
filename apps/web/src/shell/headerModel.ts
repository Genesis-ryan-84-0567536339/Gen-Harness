/** Level names from the design's autonomy scale (profile › autonomySteps). */
export const AUTONOMY_LEVELS = [
  'Chỉ ghi nhận',
  'Tóm tắt',
  'Chấm điểm + giải thích',
  'Gợi ý hành động',
  'Soạn sẵn chờ duyệt',
  'Tự làm việc thấp rủi ro',
  'Tự làm việc đã whitelist',
];

export function autonomyTooltip(level: number): string {
  const name = AUTONOMY_LEVELS[level];
  const lower = name ? name.charAt(0).toLocaleLowerCase('vi') + name.slice(1) : '';
  return `Mức tự trị hiện tại — mức ${level}${lower ? `: ${lower}` : ''} (thang 0–6)`;
}

/** data_confidence may arrive as a 0–1 fraction or a 0–100 percent. */
export function confidencePercent(v: number | null | undefined): number | null {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Math.round(v <= 1 ? v * 100 : v);
}
