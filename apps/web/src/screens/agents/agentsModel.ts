/** Presentation logic for the Agent Identity cluster — mirrors `dataModel.ts` conventions (token colours only). */
import type { AgentChannelScope, AgentDecision, AgentIdentity } from '@gen-harness/contracts';
import { fmtAgo } from '../../lib/format';

export const OK = 'var(--color-ok)';
export const WARN = 'var(--color-warn)';
export const BAD = 'var(--color-bad)';
export const ACC3 = 'var(--color-accent-300)';
export const N4 = 'var(--color-neutral-400)';
export const N5 = 'var(--color-neutral-500)';

/** ARCHITECTURE §7 — thang tự trị 0–6 cố định (`gh.chassis.policy.LEVELS`). */
export const AUTONOMY_LEVELS: Record<number, string> = {
  0: 'Chỉ ghi nhận',
  1: 'Tóm tắt',
  2: 'Chấm điểm + giải thích',
  3: 'Gợi ý hành động',
  4: 'Soạn sẵn chờ duyệt',
  5: 'Tự làm việc thấp rủi ro',
  6: 'Tự làm việc đã whitelist',
};
export const AUTONOMY_OPTIONS = Object.entries(AUTONOMY_LEVELS).map(([v, label]) => ({ value: v, label: `${v} — ${label}` }));

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
