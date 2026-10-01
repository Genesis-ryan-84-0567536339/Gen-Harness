/** Presentation logic for API & Model — mirrors `dataModel.ts` / `agentsModel.ts` conventions. */
import type { ModelGroup, Provider, ProviderKind, ProviderTestResult } from '@gen-harness/contracts';

export const OK = 'var(--color-ok)';
export const WARN = 'var(--color-warn)';
export const BAD = 'var(--color-bad)';
export const ACC3 = 'var(--color-accent-300)';
export const N4 = 'var(--color-neutral-400)';
export const N5 = 'var(--color-neutral-500)';

export const PROVIDER_ICON: Record<ProviderKind, string> = {
  antigravity_cli: 'ph ph-terminal-window',
  claude_code_cli: 'ph ph-terminal',
  gemini: 'ph ph-sparkle',
  deepseek: 'ph ph-brain',
  openai_compat: 'ph ph-plugs',
  system_one: 'ph ph-lightning',
};

export const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  antigravity_cli: 'Antigravity CLI',
  claude_code_cli: 'Claude Code CLI · gói Claude',
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
      return { label: isCliKind(p.kind) ? 'Chưa đăng nhập' : 'Chưa kiểm tra', tone: N5 };
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

// ── v0.1.31: nguồn CLI + danh sách model theo nhóm ─────────────────────────
/** Nguồn dùng phiên đăng nhập CLI (không khoá API, không xoá ở danh sách nguồn). */
export function isCliKind(kind: ProviderKind | string): kind is 'antigravity_cli' | 'claude_code_cli' {
  return kind === 'antigravity_cli' || kind === 'claude_code_cli';
}

/**
 * Nhóm model để chọn (Gemini, Claude…) từ lần kiểm tra gần nhất — chỉ khi kiểm tra OK. Máy chủ cũ (không có
 * `model_groups`) → một nhóm "Model" từ danh sách tên. Bỏ model embedding (không sinh chữ được).
 */
export function offeredGroups(t: ProviderTestResult | null | undefined): ModelGroup[] {
  if (!t?.ok) return [];
  const notEmbed = (id: string) => !/embed/i.test(id);
  if (t.model_groups?.length)
    return t.model_groups.map((g) => ({ ...g, models: g.models.filter((m) => notEmbed(m.id)) })).filter((g) => g.models.length > 0);
  const ids = (t.models ?? []).filter(notEmbed);
  return ids.length
    ? [{ label: 'Model', models: ids.map((id) => ({ id, label: id, group: 'Model', tier: 'balanced' as const, hint: '', source: 'cli' as const })) }]
    : [];
}

/** Model đang là mặc định của nguồn (đã "Dùng model này"), không có thì model đã lưu đầu tiên. */
export function currentModelName(p: Pick<Provider, 'models'>): string | null {
  return p.models.find((m) => m.is_default)?.model_name ?? p.models[0]?.model_name ?? null;
}

/** Chữ hiện trong ô chọn: "Gemini 3.8 Flash (High) · nhanh, rẻ". */
export function modelOptionText(m: { id: string; label: string; hint: string }): string {
  return m.hint ? `${m.label} · ${m.hint}` : m.label;
}
