/**
 * Gen v2 (A4) — thẻ đề xuất thao tác có xác nhận: nháp tin gửi đi, nhắc việc, giao người phụ trách.
 *
 * Gen KHÔNG tự làm: thẻ hiện form điền sẵn + tóm tắt do hệ thống viết; chỉ khi bấm **Xác nhận** web mới gọi
 * `POST /gen/proposals/{id}/confirm` (server thực hiện nhân danh người bấm qua endpoint sẵn có, đúng quyền + PIN).
 * **Sửa** mở form để chỉnh trường được phép; **Huỷ** bỏ đề xuất. Cần PIN → API trả 423, client tự hỏi PIN rồi gửi lại.
 */
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  GEN_SCREEN_BY_KEY,
  type AssignFields,
  type DraftMessageFields,
  type GenProposal,
  type ReminderFields,
  type SocialWriteFields,
} from '@gen-harness/contracts';
import { Button, Icon, SelectField, TextField } from '@gen-harness/ui';
import { api } from '../lib/api';
import { errorText } from '../lib/errorText';
import { fmtDMClock } from '../lib/format';
import { navigateTo } from '../lib/navigation';
import { useCan } from '../lib/permissions';
import { useNow } from '../lib/useNow';
import { ErrorWithDetail, WriteProofDialog } from '../social/WriteProofDialog';
import { PROOF_MISSING_TEXT, WRITE_RISK_PATH, qkSocial, writeStatusView } from '../social/socialModel';
import { patchProposal } from './genStore';
import {
  SOCIAL_SUSPICIOUS_WARNING,
  SOCIAL_WRITE_WARNING,
  WRITE_MAX_TEXT,
  WRITE_POLL_MAX_MS,
  WRITE_POLL_MS,
  changedFields,
  fromLocalInput,
  initialDraft,
  isSocialWrite,
  isTerminalJob,
  PROPOSAL_TITLE,
  writeErrorKind,
  type Draft,
} from './proposalModel';

const PROPOSAL_ICON: Record<GenProposal['type'], string> = {
  draft_message: 'ph ph-note-pencil',
  reminder: 'ph ph-alarm',
  assign: 'ph ph-user-switch',
  social_reply: 'ph ph-chat-circle-text',
  social_dm: 'ph ph-paper-plane-tilt',
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
  if (p.type === 'social_reply' || p.type === 'social_dm') {
    const f: SocialWriteFields = p.fields;
    return (
      <dl className="gen-prop__dl gen-prop__dl--social">
        <Row label="Tài khoản">{p.labels.account ?? f.account_id}</Row>
        <Row label={p.type === 'social_reply' ? 'Trả lời vào' : 'Nhắn cho'}>{p.labels.target ?? f.target_url}</Row>
        <Row label="Nội dung">
          <span className="gen-prop__text">{f.text}</span>
        </Row>
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
  const needsPeople = p.type === 'reminder' || p.type === 'assign';
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

  if (p.type === 'social_reply' || p.type === 'social_dm')
    return (
      <div className="gen-prop__form">
        <div className="gh-field">
          <label className="gh-field__label" htmlFor={`gen-prop-text-${p.id}`}>
            Nội dung
          </label>
          <textarea id={`gen-prop-text-${p.id}`} className="gh-input" rows={5} maxLength={WRITE_MAX_TEXT} value={draft.text} onChange={(e) => set('text', e.target.value)} />
        </div>
      </div>
    );
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
  if (isSocialWrite(p)) return !!d.text?.trim() && d.text.length <= WRITE_MAX_TEXT;
  return !!d.user_id;
}

/** Theo dõi việc gửi (poll mỗi 2 giây, dừng khi xong, tối đa 4 phút): chờ → đang gửi → đã gửi (+ ảnh chụp) / lỗi / đã dừng. */
function WriteProgress({ jobId, initial }: { jobId: string; initial?: string }) {
  const started = useRef(Date.now());
  const now = useNow(5000);
  const [proof, setProof] = useState(false);
  const q = useQuery({
    queryKey: qkSocial.job(jobId),
    queryFn: ({ signal }) => api.social.job(jobId, signal),
    refetchInterval: (query) =>
      isTerminalJob(query.state.data?.status) || Date.now() - started.current > WRITE_POLL_MAX_MS ? false : WRITE_POLL_MS,
  });
  const job = q.data;
  const status = job?.status ?? (initial as 'queued' | undefined) ?? 'queued';
  const view = writeStatusView(job ?? { status: status as 'queued' });
  const timedOut = !view.terminal && now - started.current > WRITE_POLL_MAX_MS;
  const icon =
    status === 'done' ? 'ph-fill ph-check-circle' : status === 'failed' ? 'ph ph-warning-circle' : status === 'halted' || status === 'cancelled' ? 'ph ph-hand-palm' : 'ph ph-circle-notch';
  return (
    <div className="gen-prop__write" data-testid="gen-write-status" data-status={status} aria-live="polite">
      <div className="gen-prop__write-line" data-tone={view.tone}>
        <Icon name={icon} size={13} />
        <span>{view.label}</span>
      </div>
      {status === 'failed' ? (
        <ErrorWithDetail text={job?.error_text || 'Việc gửi gặp lỗi — chưa có gì được gửi đi.'} detail={job?.error ? `Mã lỗi ${job.error}` : null} />
      ) : null}
      {view.notes
        .filter((n) => n !== PROOF_MISSING_TEXT)
        .map((n) => (
          <p key={n} className="gen-prop__note">
            {n}
          </p>
        ))}
      {status === 'done' && job?.has_proof !== false ? (
        <Button variant="secondary" className="btn-27" icon="ph ph-image" onClick={() => setProof(true)}>
          Xem ảnh chụp
        </Button>
      ) : null}
      {status === 'done' && job?.has_proof === false ? (
        <ErrorWithDetail text={PROOF_MISSING_TEXT} detail={job.result?.proof_error ? `Mã lỗi ${job.result.proof_error}` : null} className="write-error gen-prop__proof-missing" />
      ) : null}
      {timedOut ? (
        <>
          <p className="gen-prop__note">Chưa thấy kết quả sau 4 phút — Sếp xem ở trang Tài khoản mạng xã hội (Lần gửi gần đây).</p>
          <Button variant="secondary" className="btn-27" icon="ph ph-arrow-square-out" onClick={() => navigateTo('/social')}>
            Mở Tài khoản mạng xã hội
          </Button>
        </>
      ) : null}
      {q.isError && !job ? <ErrorWithDetail error={q.error} /> : null}
      {proof ? <WriteProofDialog jobId={jobId} open onClose={() => setProof(false)} /> : null}
    </div>
  );
}

export function ProposalCard({ proposal: p }: { proposal: GenProposal }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(p));
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorRaw, setErrorRaw] = useState<unknown>(null);
  const social = isSocialWrite(p);
  // Cổng ghi: nhãn lúc đề xuất có thể đã cũ (Sếp vừa đồng ý ở trang cảnh báo) → hỏi lại cổng khi thẻ còn chờ và đang khoá.
  const labelLocked = social && p.labels.write_gate === 'locked';
  const gate = useQuery({
    queryKey: qkSocial.writeGate,
    queryFn: ({ signal }) => api.social.writeGate(signal),
    enabled: labelLocked && p.status === 'pending',
    retry: false,
  });
  const locked = labelLocked && !gate.data?.open;
  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  const confirm = async () => {
    setBusy('confirm');
    setError(null);
    setErrorRaw(null);
    try {
      const next = await api.gen.confirmProposal(p.id, editing ? changedFields(p, draft) : {});
      setEditing(false);
      patchProposal(next);
    } catch (e) {
      setError(errorText(e));
      setErrorRaw(e);
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
  // v0.1.43 (F-24): nháp tin chỉ được LƯU, chưa gửi — nói rõ và dẫn thẳng tới đúng nháp ở Bàn làm việc để duyệt/gửi.
  const isDraft = p.type === 'draft_message';
  const draftId = isDraft && p.result?.type === 'draft' && p.result.id ? p.result.id : null;
  // Chỉ hứa "Mở để duyệt và gửi" khi nháp gửi được THẬT (API báo có nơi gửi) VÀ người bấm có quyền duyệt; còn lại chỉ mở nháp.
  // `sendable` thiếu (kết quả lưu trước v0.1.43) = không rõ → chỉ chip "Mở nháp" trung tính, KHÔNG khẳng định "chưa có nơi gửi".
  const canApprove = useCan('action.approve');
  const sendable = p.result?.sendable === true;
  const noTarget = p.result?.sendable === false;
  const draftNote = !draftId ? null : noTarget ? 'Nháp chưa có nơi gửi' : sendable && !canApprove ? 'Chờ Sếp duyệt rồi mới gửi' : null;
  const code = p.result?.code ? ` · ${p.result.code}` : '';
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
      {social && p.status === 'pending' ? (
        <>
          <p className="gen-prop__warn gen-prop__warn--send" role="note">
            <Icon name="ph ph-warning" size={13} /> {SOCIAL_WRITE_WARNING}
          </p>
          {p.labels.suspicious === '1' ? (
            <p className="gen-prop__warn gen-prop__warn--yellow" role="note" data-testid="gen-write-suspicious">
              <Icon name="ph ph-seal-warning" size={13} /> {SOCIAL_SUSPICIOUS_WARNING}
            </p>
          ) : null}
          {locked ? (
            <p className="gen-prop__warn" role="note" data-testid="gen-write-locked">
              <Icon name="ph ph-lock-simple" size={13} /> Gửi lên Facebook đang khoá — Sếp cần đọc cảnh báo và đồng ý (hoặc bật sandbox) trước.
            </p>
          ) : null}
        </>
      ) : null}
      {error && social ? (
        <>
          <ErrorWithDetail error={errorRaw} text={error} className="gen-prop__error write-error" />
          {writeErrorKind((errorRaw as { code?: string } | null)?.code) === 'locked' ? (
            <Button variant="secondary" className="btn-27" icon="ph ph-shield-warning" onClick={() => navigateTo(WRITE_RISK_PATH)}>
              Đọc cảnh báo & đồng ý
            </Button>
          ) : null}
        </>
      ) : error ? (
        <p className="gen-prop__error" role="alert">
          {error}
        </p>
      ) : null}
      {p.status === 'pending' ? (
        <div className="gen-prop__actions">
          <Button variant="primary" className="btn-27" icon="ph ph-check" loading={busy === 'confirm'} disabled={busy !== null || locked || (editing && !valid(p, draft))} onClick={() => void confirm()}>
            {social ? 'Xác nhận và gửi' : 'Xác nhận'}
          </Button>
          {locked ? (
            <Button variant="secondary" className="btn-27" icon="ph ph-shield-warning" disabled={busy !== null} onClick={() => navigateTo(WRITE_RISK_PATH)}>
              Đọc cảnh báo & đồng ý
            </Button>
          ) : null}
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
      ) : p.status === 'confirmed' && social && p.result?.type === 'social_write' && p.result.id ? (
        <WriteProgress jobId={p.result.id} initial={p.result.status} />
      ) : p.status === 'confirmed' ? (
        <div className="gen-prop__done">
          {isDraft ? (
            <>
              <Icon name="ph ph-floppy-disk" size={13} /> Đã lưu nháp — chưa gửi{code}
            </>
          ) : (
            <>
              <Icon name="ph-fill ph-check-circle" size={13} /> Đã xác nhận{code}
            </>
          )}
          {draftId && sendable && canApprove ? (
            <Button variant="primary" className="btn-27" icon="ph ph-arrow-square-out" onClick={() => navigateTo(`/workbench?id=${encodeURIComponent(draftId)}`)}>
              Mở để duyệt và gửi
            </Button>
          ) : draftId ? (
            <>
              {draftNote ? <span className="gen-prop__note">{draftNote}</span> : null}
              <button type="button" className="gen-chip gen-chip--btn" onClick={() => navigateTo(`/workbench?id=${encodeURIComponent(draftId)}`)}>
                <Icon name="ph ph-arrow-square-out" size={11} /> {noTarget ? 'Mở nháp ở Bàn làm việc' : 'Mở nháp'}
              </button>
            </>
          ) : resultScreen ? (
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
