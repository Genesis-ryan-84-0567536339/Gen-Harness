/** Gen v2 (A4) — hàm thuần cho thẻ đề xuất (ProposalCard): nhãn, chuyển giờ `datetime-local`, so trường đã sửa. */
import { GEN_PROPOSAL_EDITABLE, type GenProposal } from '@gen-harness/contracts';

export const PROPOSAL_TITLE: Record<GenProposal['type'], string> = {
  draft_message: 'Soạn nháp tin gửi đi',
  reminder: 'Tạo nhắc việc',
  assign: 'Giao người phụ trách',
};

/** ISO → giá trị ô `datetime-local` theo giờ máy. */
export function toLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export type Draft = Record<string, string>;

export function initialDraft(p: GenProposal): Draft {
  if (p.type === 'draft_message') return { title: p.fields.title, text: p.fields.text };
  if (p.type === 'reminder')
    return {
      title: p.fields.title,
      remind_at: toLocalInput(p.fields.remind_at),
      due_at: toLocalInput(p.fields.due_at),
      priority: p.fields.priority,
      assignee_user_id: p.fields.assignee_user_id ?? '',
    };
  return { user_id: p.fields.user_id };
}

/** Chỉ gửi trường được sửa và thật sự đổi (server giữ nguyên phần còn lại). */
export function changedFields(p: GenProposal, d: Draft): Record<string, unknown> {
  const init = initialDraft(p);
  const out: Record<string, unknown> = {};
  for (const k of GEN_PROPOSAL_EDITABLE[p.type]) {
    if (d[k] === undefined || d[k] === init[k]) continue;
    out[k] = k === 'remind_at' || k === 'due_at' ? fromLocalInput(d[k]) : k === 'assignee_user_id' ? d[k] || null : d[k];
  }
  return out;
}
