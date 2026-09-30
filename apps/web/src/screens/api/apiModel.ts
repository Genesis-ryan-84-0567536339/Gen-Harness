/** Presentation logic for API & Model — mirrors `dataModel.ts` / `agentsModel.ts` conventions. */
import type { Provider, ProviderKind } from '@gen-harness/contracts';

export const OK = 'var(--color-ok)';
export const WARN = 'var(--color-warn)';
export const BAD = 'var(--color-bad)';
export const ACC3 = 'var(--color-accent-300)';
export const N4 = 'var(--color-neutral-400)';
export const N5 = 'var(--color-neutral-500)';

export const PROVIDER_ICON: Record<ProviderKind, string> = {
  antigravity_cli: 'ph ph-terminal-window',
  gemini: 'ph ph-sparkle',
  deepseek: 'ph ph-brain',
  openai_compat: 'ph ph-plugs',
  system_one: 'ph ph-lightning',
};

export const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  antigravity_cli: 'Antigravity CLI',
  gemini: 'Gemini API',
  deepseek: 'DeepSeek API',
  openai_compat: 'API tương thích OpenAI',
  system_one: 'Jev (System One) · quyết định nhanh',
};

export const AUTH_STATE_LABEL: Record<Provider['auth_state'], string> = {
  ok: 'Hoạt động',
  expiring: 'Sắp hết hạn',
  expired: 'Hết hạn',
  error: 'Lỗi kết nối',
  unconfigured: 'Chưa cấu hình',
};

export function authStateTone(s: Provider['auth_state']): string {
  return s === 'ok' ? OK : s === 'expiring' ? WARN : N5;
}

export function providerTone(p: Provider): string {
  return providerStatus(p).tone;
}

/**
 * v0.1.28 (UX N1): MỘT nhãn trạng thái cho nguồn model ở mọi màn (bước 4, API & Model, Điều khiển hệ thống › Bộ não
 * AI) — trước đây cùng một nguồn lỗi hiện "Chưa cấu hình" / "Chờ kết nối" / "Lỗi kết nối" / "Hoạt động" tuỳ màn.
 * Khớp `state_label` của `GET /providers/credentials` (máy chủ).
 */
export function providerStatus(p: Pick<Provider, 'enabled' | 'auth_state' | 'kind'> & { models?: Provider['models'] }): { label: string; tone: string } {
  if (!p.enabled) return { label: 'Đã tắt', tone: N5 };
  switch (p.auth_state) {
    case 'ok':
      return p.kind !== 'system_one' && p.models && p.models.length === 0 ? { label: 'Chưa chọn model', tone: WARN } : { label: 'Hoạt động', tone: OK };
    case 'expiring':
      return { label: 'Sắp hết hạn', tone: WARN };
    case 'expired':
      return { label: 'Hết hạn', tone: BAD };
    case 'error':
      return { label: 'Lỗi kết nối', tone: BAD };
    default:
      return { label: p.kind === 'antigravity_cli' ? 'Chưa đăng nhập' : 'Chưa kiểm tra', tone: N5 };
  }
}

/** ARCHITECTURE §11 — tham số core dùng cho `core.refinery` (sàng lọc thô → sạch). */
export function fmtTemperature(t: number): string {
  return t.toFixed(2).replace('.', ',');
}

export function fmtContextTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k token` : `${n} token`;
}

export function fmtRateLimit(n: number | null): string {
  return n == null ? 'không giới hạn' : `${n} / phút`;
}

export function fmtQuota(used: number, quota: number | null): string {
  if (quota == null) return `${used.toLocaleString('vi-VN')} · không hạn mức`;
  const leftPct = Math.max(0, Math.round(100 - (used * 100) / quota));
  return `${used.toLocaleString('vi-VN')} / ${quota.toLocaleString('vi-VN')} · còn ${leftPct}%`;
}
