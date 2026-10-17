/** Presentation logic for the Agent Identity cluster — mirrors `dataModel.ts` conventions (token colours only). */
import {
  AUTONOMY_DEFAULT_LEVEL,
  AUTONOMY_LEVELS as CONTRACT_AUTONOMY_LEVELS,
  autonomyPatch,
  type AgentChannelScope,
  type AgentChannelScopeIn,
  type AgentCreateBody,
  type AgentDecision,
  type AgentIdentity,
  type AgentPatchBody,
  type AgentTemplate,
} from '@gen-harness/contracts';
import { fmtAgo } from '../../lib/format';

export const OK = 'var(--color-ok)';
export const WARN = 'var(--color-warn)';
export const BAD = 'var(--color-bad)';
export const ACC3 = 'var(--color-accent-300)';
export const N4 = 'var(--color-neutral-400)';
export const N5 = 'var(--color-neutral-500)';

/**
 * ARCHITECTURE §7 — thang tự trị 0–6 cố định; dẫn xuất từ nguồn duy nhất `@gen-harness/contracts` (khớp
 * `gh.chassis.policy.LEVELS`). v0.1.43 (F-30): ô chọn 7 mức đã thay bằng `AutonomySelect` 3 mức.
 */
export const AUTONOMY_LEVELS: Record<number, string> = Object.fromEntries(CONTRACT_AUTONOMY_LEVELS.map((label, n) => [n, label]));

/** Icon + tone theo mẫu (spec E13); agent tự đặt tay (`template: null`) dùng icon trung tính. */
const TEMPLATE_ICON: Record<string, { icon: string; tone: string }> = {
  commercial: { icon: 'ph ph-handshake', tone: ACC3 },
  key_account: { icon: 'ph ph-star', tone: WARN },
  admin: { icon: 'ph ph-clipboard-text', tone: N4 },
  cs: { icon: 'ph ph-headset', tone: OK },
  recruiter: { icon: 'ph ph-users-three', tone: ACC3 },
  secretary: { icon: 'ph ph-notebook', tone: N4 },
  mascot: { icon: 'ph ph-smiley', tone: WARN },
};
export function agentIcon(a: Pick<AgentIdentity, 'template'>): { icon: string; tone: string } {
  return (a.template && TEMPLATE_ICON[a.template]) || { icon: 'ph ph-user-focus', tone: N4 };
}

export function scopeSummary(scopes: AgentChannelScope[]): string {
  if (scopes.length === 0) return 'Chưa gán kênh';
  return scopes
    .map((s) => (s.group_name ? `${s.channel_type} · ${s.group_name}` : `${s.channel_type} · cả kênh`))
    .join(', ');
}

export const DECISION_LABEL: Record<AgentDecision['decision'], string> = {
  silent: 'Im lặng',
  note: 'Ghi chú',
  suggest: 'Đề xuất',
  draft: 'Soạn nháp',
  send: 'Đã gửi',
};
export function decisionTone(d: AgentDecision['decision']): string {
  return d === 'send' ? OK : d === 'draft' || d === 'suggest' ? WARN : d === 'silent' ? N5 : N4;
}

export function decisionWhat(d: AgentDecision): string {
  const trigger = d.trigger.label ?? d.trigger.code ?? d.trigger.type;
  const prefix = DECISION_LABEL[d.decision];
  return d.draft ? `${prefix} ${d.draft.code} · ${trigger}` : `${prefix} · ${trigger}`;
}

/**
 * v0.1.67 (F083): lần lên tiếng gần nhất của RIÊNG agent (máy chủ tính theo agent, không còn nhìn 8 quyết định chung
 * của mọi agent). Chỉ tính đề xuất / soạn nháp / gửi — "Im lặng" và ghi chú không phải lên tiếng. Quyết định `send`
 * chỉ tạo nháp chờ Sếp duyệt nên ghi là "Soạn nháp", không bao giờ "Đã gửi".
 */
const SPOKE_LABEL = { suggest: 'Đề xuất', draft: 'Soạn nháp', send: 'Soạn nháp' } as const;
export function lastSpoke(agent: Pick<AgentIdentity, 'last_spoke_at' | 'last_spoke_decision'>): string {
  if (!agent.last_spoke_at) return 'Chưa từng lên tiếng';
  const what = agent.last_spoke_decision ? SPOKE_LABEL[agent.last_spoke_decision] : 'Lên tiếng';
  return `${what} · ${fmtAgo(agent.last_spoke_at)}`;
}

/** v0.1.67 (F022): dòng "MODEL" của thẻ agent + có chạy được không (`ok=false` ⇒ tô cảnh báo). */
export function modelLine(agent: Pick<AgentIdentity, 'model' | 'binding'>): { text: string; ok: boolean } {
  if (agent.model) return { text: agent.model.label, ok: agent.model.ok };
  const b = agent.binding;   // máy chủ cũ chưa trả `model`
  if (!b) return { text: 'Chuẩn (tự chọn theo vai)', ok: true };
  if (b.inactive_reason) return { text: b.inactive_reason, ok: false };
  return { text: `${b.model_name} · ${b.provider_name}`, ok: true };
}

/** Danh sách điều cấm từ ô nhập (mỗi dòng một điều) — cùng chuẩn hoá với API: bỏ khoảng trắng hai đầu, bỏ dòng rỗng. */
export function normalizeForbidden(text: string | string[]): string[] {
  const lines = Array.isArray(text) ? text : text.split('\n');
  return lines.map((s) => s.trim()).filter(Boolean);
}

/** Giá trị form "Sửa agent" (chữ thô của các ô, mức tự trị đã chọn hoặc `null` = giữ nguyên, tập kênh đã tick). */
export interface AgentFormValues {
  name: string;
  roleDesc: string;
  voice: string;
  speakWhen: string;
  forbidden: string;
  picked: number | null;
  scopeIds: Iterable<string>;
}

/**
 * v0.1.45 (F-20): thân PATCH khi SỬA agent. Các trường "rào chắn" (mức tự trị, điều cấm, phạm vi kênh) chỉ gửi khi
 * KHÁC giá trị đang lưu — máy chủ đòi mã PIN khi rào chắn đổi, nên chỉ sửa tên/mô tả thì không gửi chúng (không hỏi
 * PIN). Phạm vi kênh so theo TẬP kênh (thứ tự không quan trọng); điều cấm so danh sách đã chuẩn hoá.
 */
export function agentPatchBody(agent: AgentIdentity, form: AgentFormValues): AgentPatchBody {
  const body: AgentPatchBody = {
    name: form.name.trim(),
    role_desc: form.roleDesc.trim(),
    voice: form.voice.trim(),
    speak_when: form.speakWhen.trim(),
    template: agent.template,
    ...autonomyPatch(agent.autonomy_level, form.picked),
  };
  const forbidden = normalizeForbidden(form.forbidden);
  const current = normalizeForbidden(agent.forbidden);
  if (forbidden.length !== current.length || forbidden.some((f, i) => f !== current[i])) body.forbidden = forbidden;
  const want = new Set(form.scopeIds);
  const have = new Set(agent.channel_scopes.map((s) => s.channel_id));
  if (want.size !== have.size || [...want].some((id) => !have.has(id))) body.channel_scopes = scopesAfterTick(agent, want);
  return body;
}

/**
 * v0.1.67 (F090): kênh còn tick GIỮ NGUYÊN các dòng phạm vi theo nhóm đã có (cặp kênh + nhóm); kênh mới tick là "cả
 * kênh"; kênh bỏ tick thì mất hết dòng của nó. Trước đây gửi `[{channel_id}]` nên agent chỉ phục vụ một nhóm bỗng
 * nghe cả kênh (mọi nhóm + tin 1-1) sau khi Sếp đổi tick một kênh khác.
 */
export function scopesAfterTick(agent: Pick<AgentIdentity, 'channel_scopes'>, ticked: Set<string>): AgentChannelScopeIn[] {
  const kept = agent.channel_scopes.filter((s) => ticked.has(s.channel_id));
  const have = new Set(kept.map((s) => s.channel_id));
  return [
    ...kept.map((s) => (s.group_id ? { channel_id: s.channel_id, group_id: s.group_id } : { channel_id: s.channel_id })),
    ...[...ticked].filter((id) => !have.has(id)).map((channel_id) => ({ channel_id })),
  ];
}

/**
 * v0.1.67 thân POST khi TẠO agent. F078: chưa chọn mức ⇒ mức mặc định chung (4, "Soạn sẵn chờ duyệt") — khớp API và
 * bước 8; trước đây là mức 2 (chỉ ghi chú, không bao giờ soạn nháp) dù ô chọn ghi "dùng mức mặc định".
 * F082: mẫu tắt sẵn (Bé Heo, `default_enabled=false`) tạo ra agent TẮT.
 */
export function agentCreateBody(
  form: Omit<AgentFormValues, 'picked'> & { picked: number | null },
  template: Pick<AgentTemplate, 'code' | 'default_enabled'> | null,
): AgentCreateBody {
  return {
    name: form.name.trim(),
    role_desc: form.roleDesc.trim(),
    voice: form.voice.trim(),
    speak_when: form.speakWhen.trim(),
    autonomy_level: form.picked ?? AUTONOMY_DEFAULT_LEVEL,
    forbidden: normalizeForbidden(form.forbidden),
    template: template?.code ?? null,
    is_enabled: template ? template.default_enabled : true,
    channel_scopes: [...form.scopeIds].map((channel_id) => ({ channel_id })),
  };
}
