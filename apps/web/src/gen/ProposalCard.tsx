/**
 * Gen v2 (A4) — thẻ đề xuất thao tác có xác nhận: nháp tin gửi đi, nhắc việc, giao người phụ trách.
 *
 * Gen KHÔNG tự làm: thẻ hiện form điền sẵn + tóm tắt do hệ thống viết; chỉ khi bấm **Xác nhận** web mới gọi
 * `POST /gen/proposals/{id}/confirm` (server thực hiện nhân danh người bấm qua endpoint sẵn có, đúng quyền + PIN).
 * **Sửa** mở form để chỉnh trường được phép; **Huỷ** bỏ đề xuất. Cần PIN → API trả 423, client tự hỏi PIN rồi gửi lại.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  GEN_SCREEN_BY_KEY,
  type AssignFields,
  type DraftMessageFields,
  type GenProposal,
  type ReminderFields,
} from '@gen-harness/contracts';
import { Button, Icon, SelectField, TextField } from '@gen-harness/ui';
import { api } from '../lib/api';
import { errorText } from '../lib/errorText';
import { fmtDMClock } from '../lib/format';
import { navigateTo } from '../lib/navigation';
import { patchProposal } from './genStore';
import { changedFields, fromLocalInput, initialDraft, PROPOSAL_TITLE, type Draft } from './proposalModel';

const PROPOSAL_ICON: Record<GenProposal['type'], string> = {
  draft_message: 'ph ph-paper-plane-tilt',
  reminder: 'ph ph-alarm',
  assign: 'ph ph-user-switch',
};

const PRIORITIES = [
  { value: 'P1', label: 'P1 — gấp' },
  { value: 'P2', label: 'P2' },
  { value: 'P3', label: 'P3' },
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Summary({ p }: { p: GenProposal }) {
  if (p.type === 'draft_message') {
    const f: DraftMessageFields = p.fields;
    return (
      <dl className="gen-prop__dl">
        <Row label="Tiêu đề">{f.title}</Row>
        {p.labels.subject ? <Row label="Gửi cho">{p.labels.subject}</Row> : null}
        <Row label="Nội dung">
          <span className="gen-prop__text">{f.text}</span>
        </Row>
      </dl>
    );
  }
  if (p.type === 'reminder') {
    const f: ReminderFields = p.fields;
    return (
      <dl className="gen-prop__dl">
        <Row label="Việc">{f.title}</Row>
        <Row label="Nhắc lúc">{fmtDMClock(f.remind_at)}</Row>
        {f.due_at ? <Row label="Hạn">{fmtDMClock(f.due_at)}</Row> : null}
        <Row label="Ưu tiên">{f.priority}</Row>
        <Row label="Giao cho">{p.labels.user ?? '—'}</Row>
      </dl>
    );
  }
  const f: AssignFields = p.fields;
  return (
    <dl className="gen-prop__dl">
      <Row label={f.item_type === 'task' ? 'Việc' : 'Mục'}>{p.labels.item ?? '—'}</Row>
      <Row label="Giao cho">{p.labels.user ?? '—'}</Row>
    </dl>
  );
}

function EditForm({ p, draft, set }: { p: GenProposal; draft: Draft; set: (k: string, v: string) => void }) {
  const needsPeople = p.type !== 'draft_message';
  const people = useQuery({
    queryKey: ['gen', 'assignees'],
    queryFn: ({ signal }) => api.gen.assignees(signal),
    enabled: needsPeople,
    staleTime: 60_000,
  });
  const currentUserId = p.type === 'assign' ? p.fields.user_id : p.type === 'reminder' ? (p.fields.assignee_user_id ?? '') : '';
  const peopleOptions = [
    ...(people.data?.items ?? []).map((u) => ({ value: u.id, label: u.me ? `${u.name} (tôi)` : u.name })),
  ];
  if (currentUserId && !peopleOptions.some((o) => o.value === currentUserId)) peopleOptions.unshift({ value: currentUserId, label: p.labels.user ?? currentUserId });

  if (p.type === 'draft_message')
    return (
      <div className="gen-prop__form">
        <TextField label="Tiêu đề" value={draft.title} maxLength={200} onChange={(e) => set('title', e.target.value)} />
        <div className="gh-field">
          <label className="gh-field__label" htmlFor={`gen-prop-text-${p.id}`}>
            Nội dung
          </label>
          <textarea id={`gen-prop-text-${p.id}`} className="gh-input" rows={5} maxLength={4000} value={draft.text} onChange={(e) => set('text', e.target.value)} />
        </div>
      </div>
    );
  if (p.type === 'reminder')
    return (
      <div className="gen-prop__form">
        <TextField label="Việc" value={draft.title} maxLength={200} onChange={(e) => set('title', e.target.value)} />
        <TextField label="Nhắc lúc" type="datetime-local" value={draft.remind_at} onChange={(e) => set('remind_at', e.target.value)} />
        <TextField label="Hạn (không bắt buộc)" type="datetime-local" value={draft.due_at} onChange={(e) => set('due_at', e.target.value)} />
        <SelectField label="Ưu tiên" value={draft.priority} options={PRIORITIES} onChange={(e) => set('priority', e.target.value)} />
        <SelectField label="Giao cho" value={draft.assignee_user_id} options={peopleOptions} onChange={(e) => set('assignee_user_id', e.target.value)} />
      </div>
    );
  return (
    <div className="gen-prop__form">
      <SelectField label="Giao cho" value={draft.user_id} options={peopleOptions} onChange={(e) => set('user_id', e.target.value)} />
    </div>
  );
}

function valid(p: GenProposal, d: Draft): boolean {
  if (p.type === 'draft_message') return !!d.title?.trim() && !!d.text?.trim();
  if (p.type === 'reminder') return !!d.title?.trim() && !!fromLocalInput(d.remind_at);
  return !!d.user_id;
}

export function ProposalCard({ proposal: p }: { proposal: GenProposal }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(p));
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  const confirm = async () => {
    setBusy('confirm');
    setError(null);
    try {
      const next = await api.gen.confirmProposal(p.id, editing ? changedFields(p, draft) : {});
      setEditing(false);
      patchProposal(next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const cancel = async () => {
    setBusy('cancel');
    setError(null);
    try {
      patchProposal(await api.gen.cancelProposal(p.id));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const title = PROPOSAL_TITLE[p.type];
  const resultScreen = p.result ? GEN_SCREEN_BY_KEY[p.result.screen] : undefined;
  return (
    <div className="gen-prop" data-status={p.status} role="group" aria-label={`Đề xuất: ${title}`}>
      <div className="gen-prop__head">
        <Icon name={PROPOSAL_ICON[p.type]} size={13} />
        <span className="gen-prop__title">Đề xuất · {title}</span>
        {p.requires_pin && p.status === 'pending' ? (
          <span className="gen-prop__pin" title="Thao tác nhạy cảm — hỏi mã PIN khi xác nhận">
            <Icon name="ph ph-lock-simple" size={11} /> Cần mã PIN
          </span>
        ) : null}
      </div>
      <p className="gen-prop__summary">{p.summary}</p>
      {editing && p.status === 'pending' ? <EditForm p={p} draft={draft} set={set} /> : <Summary p={p} />}
      {error ? (
        <p className="gen-prop__error" role="alert">
          {error}
        </p>
      ) : null}
      {p.status === 'pending' ? (
        <div className="gen-prop__actions">
          <Button variant="primary" className="btn-27" icon="ph ph-check" loading={busy === 'confirm'} disabled={busy !== null || (editing && !valid(p, draft))} onClick={() => void confirm()}>
            Xác nhận
          </Button>
          <Button
            variant="secondary"
            className="btn-27"
            icon={editing ? 'ph ph-arrow-counter-clockwise' : 'ph ph-pencil-simple'}
            disabled={busy !== null}
            onClick={() => {
              if (editing) setDraft(initialDraft(p));
              setEditing((v) => !v);
            }}
          >
            {editing ? 'Bỏ sửa' : 'Sửa'}
          </Button>
          <Button variant="ghost" className="btn-27" loading={busy === 'cancel'} disabled={busy !== null} onClick={() => void cancel()}>
            Huỷ
          </Button>
        </div>
      ) : p.status === 'confirmed' ? (
        <div className="gen-prop__done">
          <Icon name="ph-fill ph-check-circle" size={13} /> Đã xác nhận{p.result?.code ? ` · ${p.result.code}` : ''}
          {resultScreen ? (
            <button type="button" className="gen-chip gen-chip--btn" onClick={() => navigateTo(resultScreen.path)}>
              <Icon name="ph ph-arrow-square-out" size={11} /> Mở {resultScreen.title}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="gen-prop__done gen-prop__done--off">
          <Icon name="ph ph-x-circle" size={13} /> Đã huỷ — không làm gì
        </div>
      )}
    </div>
  );
}
