import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Profile } from '@gen-harness/contracts';
import { Button, Card, Dialog, EmptyState, Icon, TextField } from '@gen-harness/ui';
import { fmtDMClock } from '../../lib/format';
import { useUrlState } from '../../lib/uiStore';
import { CardError, InlineError, Panel, SkeletonLines } from '../common';
import { WhyButton } from '../core/Evidence';
import { errorText } from '../../lib/errorText';
import { AUTONOMY_STEPS, SUMMARY_TONE, channelIcon, channelTone, eventTone, fmtBytes, initialsOf } from './relationsModel';
import { useProfile, useUpdateProfile } from './queries';

export function ProfileScreen() {
  const [id] = useUrlState<string>('id', '');
  const q = useProfile(id || null);

  if (!id) {
    return (
      <div className="screen">
        <Card>
          <EmptyState icon="ph ph-identification-card" title="Chưa chọn hồ sơ" description="Mở một hồ sơ từ Nhóm & Con người hoặc Bản đồ quan hệ." />
        </Card>
      </div>
    );
  }
  if (q.isPending) {
    return (
      <div className="screen">
        <SkeletonLines rows={8} />
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="screen">
        <CardError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      </div>
    );
  }
  return <ProfileBody id={id} p={q.data} />;
}

function ProfileBody({ id, p }: { id: string; p: Profile }) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [autonomyOpen, setAutonomyOpen] = useState(false);

  return (
    <div className="screen">
      <Link to="/directory" className="gh-btn gh-btn--ghost pf-back">
        <Icon name="ph ph-arrow-left" size={13} />
        Quay lại Nhóm &amp; Con người
      </Link>

      <div className="pf-head">
        <span className="pf-head__av" aria-hidden>
          {initialsOf(p.person.name)}
        </span>
        <div className="pf-head__body">
          <div className="pf-head__row">
            <span className="pf-head__name">{p.person.name}</span>
            {p.person.type ? <span className="mono-tag">{p.person.type}</span> : null}
          </div>
          <div className="pf-head__identities">
            {p.identities.map((idn) => (
              <span className="pf-identity" key={idn.id}>
                <Icon name={channelIcon(idn.channel.type)} size={13} color={channelTone(idn.channel.type)} />
                {idn.channel.name} · {idn.handle ?? idn.phone_e164 ?? idn.external_id}
              </span>
            ))}
            {p.merge_history.length > 0 ? (
              <Button variant="ghost" size="sm" icon="ph ph-git-merge">
                Xem lịch sử hợp nhất ({p.merge_history.length})
              </Button>
            ) : null}
          </div>
        </div>
        <div className="pf-head__actions">
          <Button variant="secondary" icon="ph ph-user-plus" onClick={() => setNoteOpen(true)}>
            Gán phụ trách / ghi chú
          </Button>
          <Link to="/workbench" className="gh-btn gh-btn--primary pf-head__workbench">
            <Icon name="ph ph-pen-nib" size={14} />
            Mở bàn làm việc
          </Link>
        </div>
      </div>

      <div className="pf-scores">
        {p.scores.map((s) => (
          <div className="pf-score" key={s.dimension}>
            <div className="pf-score__head">
              <span className="pf-score__label">{s.label}</span>
              {s.trend ? <Icon name={s.trend === 'up' ? 'ph ph-trend-up' : s.trend === 'down' ? 'ph ph-trend-down' : 'ph ph-minus'} size={13} /> : null}
            </div>
            <div className="pf-score__value">{Math.round(s.value)}</div>
            <div className="pf-score__updated">cập nhật {fmtDMClock(s.updated_at)}</div>
            <WhyButton kind="score" id={`person:${id}:${s.dimension}`} icon={null} iconRight="ph ph-arrow-right" size="sm" className="pf-score__why">
              Vì sao
            </WhyButton>
          </div>
        ))}
      </div>

      <div className="pf-grid">
        <div className="pf-col">
          <Panel title="Hệ thống hiểu gì về đối tượng này" kicker="Tóm tắt tự cập nhật">
            {p.summary.length === 0 ? (
              <EmptyState icon="ph ph-brain" title="Chưa có tóm tắt" description="Cần thêm đơn vị ý nghĩa để hệ thống tổng hợp." />
            ) : (
              <div className="pf-summary">
                {p.summary.map((ln, i) => (
                  <div className="pf-summary__row" key={i}>
                    <span className="pf-summary__dot" style={{ background: SUMMARY_TONE[ln.tone] }} />
                    <span className="pf-summary__text">{ln.text}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Dòng sự kiện" kicker="Sự kiện có nghĩa, không phải log tin nhắn">
            {p.timeline.length === 0 ? (
              <EmptyState icon="ph ph-clock-counter-clockwise" title="Chưa có sự kiện nào" />
            ) : (
              <div className="pf-timeline">
                {p.timeline.map((tl) => (
                  <div className="pf-timeline__row" key={tl.id}>
                    <span className="pf-timeline__time">{fmtDMClock(tl.observed_at)}</span>
                    <span className="mono-tag" style={{ color: eventTone(tl.event_type) }}>
                      {tl.event_type}
                    </span>
                    <span className="pf-timeline__detail">{tl.conclusion}</span>
                    <WhyButton kind="meaning_unit" id={tl.id} icon={null} size="sm">
                      Chứng cứ
                    </WhyButton>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="pf-col">
          <Panel title="Mức tự trị với đối tượng này" kicker={`Thang 0–6 · đang đặt mức ${p.autonomy_level ?? '—'}`}>
            <div className="pf-autonomy">
              <div className="pf-autonomy__steps">
                {AUTONOMY_STEPS.map((title, n) => (
                  <span key={n} className="pf-autonomy__step" data-on={p.autonomy_level !== null && n <= p.autonomy_level} title={`Mức ${n} — ${title}`}>
                    {n}
                  </span>
                ))}
              </div>
              <p className="pf-autonomy__desc">{p.autonomy_level !== null ? `Mức ${p.autonomy_level} — ${AUTONOMY_STEPS[p.autonomy_level]}.` : 'Chưa đặt mức tự trị riêng cho đối tượng này — dùng mức mặc định.'}</p>
              <Button variant="ghost" size="sm" icon="ph ph-sliders-horizontal" onClick={() => setAutonomyOpen(true)}>
                Đổi mức tự trị
              </Button>
            </div>
          </Panel>

          <Panel title="Tài liệu đã trao đổi" kicker="Documents">
            {p.documents.length === 0 ? (
              <EmptyState icon="ph ph-files" title="Chưa có tài liệu nào" />
            ) : (
              <div className="pf-list">
                {p.documents.map((d) => (
                  <div className="pf-list__row" key={d.id}>
                    <Icon name="ph ph-file-text" size={15} color="var(--color-neutral-400)" />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="pf-list__title">{d.title}</div>
                      <div className="pf-list__meta">{fmtDMClock(d.created_at)} · {fmtBytes(d.bytes)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Người nội bộ từng chạm" kicker="Internal touchpoints">
            {p.touchpoints.length === 0 ? (
              <EmptyState icon="ph ph-users-three" title="Chưa ai từng chạm hồ sơ này" />
            ) : (
              <div className="pf-list">
                {p.touchpoints.map((u) => (
                  <div className="pf-list__row" key={u.id}>
                    <span className="pf-touch-av">{initialsOf(u.name)}</span>
                    <span className="pf-list__title" style={{ flex: 1 }}>{u.name}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Ghi chú tay của Sếp" kicker="Owner notes · hệ thống không sửa">
            {p.owner_note ? <p className="pf-note">{p.owner_note}</p> : <EmptyState icon="ph ph-note-pencil" title="Chưa có ghi chú" />}
          </Panel>
        </div>
      </div>

      {noteOpen ? <NoteDialog id={id} p={p} onClose={() => setNoteOpen(false)} /> : null}
      {autonomyOpen ? <AutonomyDialog id={id} p={p} onClose={() => setAutonomyOpen(false)} /> : null}
    </div>
  );
}

function AutonomyDialog({ id, p, onClose }: { id: string; p: Profile; onClose: () => void }) {
  const update = useUpdateProfile();
  const [level, setLevel] = useState(p.autonomy_level ?? 3);
  return (
    <DialogShell
      title="Mức tự trị với đối tượng này"
      kicker={p.person.name}
      onClose={onClose}
      busy={update.isPending}
      error={update.isError ? update.error : null}
      onSave={() => update.mutate({ id, body: { autonomy_level: level } }, { onSuccess: onClose })}
    >
      <div className="pf-autonomy__steps">
        {AUTONOMY_STEPS.map((title, n) => (
          <button key={n} type="button" className="pf-autonomy__step pf-autonomy__step--btn" data-on={n <= level} aria-pressed={n === level} title={title} onClick={() => setLevel(n)}>
            {n}
          </button>
        ))}
      </div>
      <p className="pf-autonomy__desc">Mức {level} — {AUTONOMY_STEPS[level]}.</p>
    </DialogShell>
  );
}

function NoteDialog({ id, p, onClose }: { id: string; p: Profile; onClose: () => void }) {
  const update = useUpdateProfile();
  const [note, setNote] = useState(p.owner_note ?? '');
  return (
    <DialogShell
      title="Gán phụ trách / ghi chú tay"
      kicker={p.person.name}
      onClose={onClose}
      busy={update.isPending}
      error={update.isError ? update.error : null}
      onSave={() => update.mutate({ id, body: { note: note.trim() || null } }, { onSuccess: onClose })}
    >
      <TextField label="Ghi chú tay của Sếp" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
    </DialogShell>
  );
}

function DialogShell({
  title, kicker, onClose, onSave, busy, error, children,
}: {
  title: string; kicker: string; onClose: () => void; onSave: () => void; busy: boolean; error: unknown; children: ReactNode;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      width={420}
      title={title}
      kicker={kicker}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="primary" icon="ph ph-check" loading={busy} onClick={onSave}>
            Lưu
          </Button>
        </>
      }
    >
      <div className="dlg-fields">
        {children}
        {error ? <InlineError>{errorText(error)}</InlineError> : null}
      </div>
    </Dialog>
  );
}
