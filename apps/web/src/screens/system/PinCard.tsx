import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '@gen-harness/contracts';
import { Button, Dialog, EmptyState, PinInput } from '@gen-harness/ui';
import { api } from '../../lib/api';
import { fmtDMClock } from '../../lib/format';
import { useCan, useOrgTimezone } from '../../lib/permissions';
import { toast } from '../../lib/toast';
import { PIN_RULES } from '../../setup/steps';
import { errorText } from '../../lib/errorText';
import { CardError, InlineError, Panel, SkeletonLines, StateChip } from '../common';
import { BAD, N4, OK, WARN } from '../data/dataModel';

/** Mã PIN xác nhận thao tác (design `pinDigits` + `pinRules`). */
export function PinCard() {
  const canAudit = useCan('audit.read');
  const [changeOpen, setChangeOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <Panel title="Mã PIN xác nhận thao tác" kicker="6 chữ số · bảo vệ mọi thao tác nhạy cảm" label="Mã PIN xác nhận thao tác">
      <div className="pin-body">
        <div className="pin-digits" aria-label="Mã PIN đã đặt, 6 chữ số" role="img">
          {Array.from({ length: 6 }, (_, i) => (
            <span className="pin-digit" key={i} aria-hidden>
              •
            </span>
          ))}
        </div>
        {PIN_RULES.map(([k, v]) => (
          <div className="pin-rule" key={k}>
            <span className="pin-rule__k">{k}</span>
            <span className="pin-rule__v">{v}</span>
          </div>
        ))}
        <div className="pin-actions">
          <Button variant="primary" icon="ph ph-password" onClick={() => setChangeOpen(true)}>
            Đổi mã PIN
          </Button>
          {canAudit ? (
            <Button variant="secondary" icon="ph ph-clock-counter-clockwise" onClick={() => setHistoryOpen(true)}>
              Lịch sử nhập
            </Button>
          ) : null}
        </div>
      </div>
      <ChangePinDialog open={changeOpen} onClose={() => setChangeOpen(false)} />
      <PinHistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </Panel>
  );
}

function ChangePinDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  useEffect(() => {
    if (open) {
      setCur('');
      setNext('');
      setConfirm('');
    }
  }, [open]);
  const mismatch = confirm.length === 6 && next !== confirm;
  const same = next.length === 6 && next === cur;
  const valid = cur.length === 6 && next.length === 6 && next === confirm && !same;
  const save = useMutation({
    mutationFn: () => api.auth.changePin(cur, next),
    onSuccess: () => {
      toast('Đã đổi mã PIN');
      onClose();
    },
  });
  const err = save.error;
  const wrongCurrent = err instanceof ApiError && (err.code === 'PIN_INVALID' || err.status === 403);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={400}
      title="Đổi mã PIN"
      kicker="6 chữ số · mọi lần đổi đều vào nhật ký"
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="primary" icon="ph ph-check" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            Lưu mã mới
          </Button>
        </>
      }
    >
      <form
        className="dlg-fields"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <div className="dlg-fields" style={{ gap: 6 }}>
          <span className="dlg-section-title">PIN hiện tại</span>
          <PinInput value={cur} onChange={setCur} label="PIN hiện tại" autoFocus invalid={wrongCurrent} idPrefix="pin-cur" />
        </div>
        <div className="dlg-fields" style={{ gap: 6 }}>
          <span className="dlg-section-title">PIN mới</span>
          <PinInput value={next} onChange={setNext} label="PIN mới" invalid={same} idPrefix="pin-new" />
        </div>
        <div className="dlg-fields" style={{ gap: 6 }}>
          <span className="dlg-section-title">Nhập lại PIN mới</span>
          <PinInput value={confirm} onChange={setConfirm} label="Nhập lại PIN mới" invalid={mismatch} idPrefix="pin-confirm" />
        </div>
        <InlineError>
          {same
            ? 'PIN mới phải khác PIN hiện tại.'
            : mismatch
              ? 'Hai lần nhập PIN mới chưa khớp.'
              : err
                ? wrongCurrent
                  ? 'PIN hiện tại không đúng.'
                  : errorText(err)
                : null}
        </InlineError>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

const PIN_ACTION_LABEL: Record<string, { label: string; tone: string }> = {
  'auth.pin_verified': { label: 'Nhập đúng', tone: OK },
  'auth.pin_failed': { label: 'Nhập sai', tone: WARN },
  'auth.pin_locked': { label: 'Khoá 15 phút', tone: BAD },
  'auth.pin_attempt_while_locked': { label: 'Nhập khi đang khoá', tone: BAD },
  'auth.pin_changed': { label: 'Đổi PIN', tone: N4 },
};

function PinHistoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tz = useOrgTimezone();
  const q = useQuery({
    queryKey: ['audit', 'pin'],
    queryFn: () => api.audit.list({ action: 'auth.pin', limit: 30 }),
    enabled: open,
  });
  return (
    <Dialog open={open} onClose={onClose} width={480} title="Lịch sử nhập PIN" kicker="30 lần gần nhất · từ Action Log">
      {q.isPending ? (
        <SkeletonLines rows={4} padding="0" />
      ) : q.isError ? (
        <CardError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : q.data.items.length === 0 ? (
        <EmptyState icon="ph ph-password" title="Chưa có lần nhập PIN nào" />
      ) : (
        <div>
          {q.data.items.map((a) => {
            const l = PIN_ACTION_LABEL[a.action] ?? { label: a.action, tone: N4 };
            return (
              <div className="profile-row" key={a.id}>
                <span className="td-id" style={{ width: 110, flex: 'none' }}>
                  {fmtDMClock(a.at, tz)}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--color-neutral-300)' }}>{a.actor_label ?? '—'}</span>
                <StateChip color={l.tone} border={l.tone === N4 ? 'var(--color-neutral-800)' : l.tone}>
                  {l.label}
                </StateChip>
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
