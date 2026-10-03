/** Presentation logic for the Agent Identity cluster — mirrors `dataModel.ts` conventions (token colours only). */
import {
  AUTONOMY_LEVELS as CONTRACT_AUTONOMY_LEVELS,
  autonomyPatch,
  type AgentChannelScope,
  type AgentDecision,
  type AgentIdentity,
  type AgentPatchBody,
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

export function lastSpoke(agentId: string, decisions: AgentDecision[]): string {
  const last = decisions.find((d) => d.agent.id === agentId);
  if (!last) return 'Chưa từng lên tiếng';
  return `${DECISION_LABEL[last.decision]} · ${fmtAgo(last.at)}`;
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
  if (want.size !== have.size || [...want].some((id) => !have.has(id))) {
    body.channel_scopes = [...want].map((channel_id) => ({ channel_id }));
  }
  return body;
}
