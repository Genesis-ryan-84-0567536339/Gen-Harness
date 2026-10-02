import { autonomyLabel } from '@gen-harness/contracts';

export function autonomyTooltip(level: number): string {
  const name = autonomyLabel(level);
  const lower = name ? name.charAt(0).toLocaleLowerCase('vi') + name.slice(1) : '';
  return `Mức tự trị hiện tại — mức ${level}${lower ? `: ${lower}` : ''} (thang 0–6)`;
}

/** data_confidence may arrive as a 0–1 fraction or a 0–100 percent. */
export function confidencePercent(v: number | null | undefined): number | null {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Math.round(v <= 1 ? v * 100 : v);
}

/** "9+" khi quá 9 — huy hiệu giữ gọn trong nút 32px. */
export function badgeText(n: number): string {
  return n > 9 ? '9+' : String(n);
}
