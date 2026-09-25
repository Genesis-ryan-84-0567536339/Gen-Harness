import { useState } from 'react';
import { Button, EmptyState, Icon, SelectField, TextField } from '@gen-harness/ui';
import { api } from '../lib/api';
import { StepFrame } from './StepFrame';
import { describeError, type StepProps } from './types';

type InviteRole = 'manager' | 'operator' | 'agent_staff' | 'auditor';
const ROLE_OPTIONS: Array<{ value: InviteRole; label: string }> = [
  { value: 'manager', label: 'Manager · quản lý team' },
  { value: 'operator', label: 'Operator · vận hành' },
  { value: 'agent_staff', label: 'Agent nhân viên' },
  { value: 'auditor', label: 'Auditor · kiểm toán' },
];

interface Row {
  id: number;
  display_name: string;
  email: string;
  role: InviteRole;
}
let rowSeq = 0;
const emptyRow = (): Row => ({ id: ++rowSeq, display_name: '', email: '', role: 'operator' });

interface InvitedRow {
  id: string;
  display_name: string;
  email: string;
  role: string;
  temp_password: string;
}

/** Bước 10 — Mời đội ngũ (tuỳ chọn, PLAN 4.6). Danh sách rỗng vẫn lưu được ("Owner mời sau ở Quyền hạn"). */
export function Step10Team({ meta, description, onBack, onSaved, formRef, onSkip, skipping, skipError }: StepProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [invited, setInvited] = useState<InvitedRow[] | null>(null);
  const [nextStateReady, setNextStateReady] = useState<(() => void) | null>(null);

  const addRow = () => setRows((r) => [...r, emptyRow()]);
  const removeRow = (id: number) => setRows((r) => r.filter((x) => x.id !== id));
  const updateRow = (id: number, patch: Partial<Row>) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const isFilled = (r: Row) => r.display_name.trim() !== '' && r.email.trim() !== '';
  const isPartial = (r: Row) => (r.display_name.trim() !== '') !== (r.email.trim() !== '');
  const hasPartial = rows.some(isPartial);
  const canContinue = !hasPartial;

  const save = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const state = await api.setup.step10({
        invites: rows.filter(isFilled).map((r) => ({ display_name: r.display_name.trim(), email: r.email.trim().toLowerCase(), role: r.role })),
      });
      if (state.invited.length > 0) {
        setInvited(state.invited);
        setNextStateReady(() => () => onSaved(state));
      } else {
        onSaved(state);
      }
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  if (invited) {
    return (
      <StepFrame
        n={meta.n}
        title={meta.title}
        description={description}
        canContinue
        onContinue={() => nextStateReady?.()}
        onBack={onBack}
        continueLabel="Đã lưu, sang bước sau"
      >
        <div className="setup-section">
          <div className="setup-section__title">Đã tạo {invited.length} tài khoản — chưa gửi thư mời thật</div>
          <p className="muted-note">Chưa nối SMTP thật ở giai đoạn này: mật khẩu tạm hiện thẳng dưới đây, Sếp tự gửi qua kênh riêng (Zalo, email cá nhân…) rồi đổi lại ở lần đăng nhập đầu.</p>
          <div className="invite-result-list">
            {invited.map((inv) => (
              <div className="invite-result-row" key={inv.id}>
                <Icon name="ph ph-user-plus" size={15} color="var(--color-accent-300)" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="invite-result-row__name">
                    {inv.display_name} · {ROLE_OPTIONS.find((r) => r.value === inv.role)?.label ?? inv.role}
                  </div>
                  <div className="invite-result-row__email">{inv.email}</div>
                </div>
                <span className="mono invite-result-row__pw">{inv.temp_password}</span>
              </div>
            ))}
          </div>
        </div>
      </StepFrame>
    );
  }

  return (
    <StepFrame
      n={meta.n}
      title={meta.title}
      description={description}
      formRef={formRef}
      canContinue={canContinue}
      busy={busy}
      onContinue={() => void save()}
      onBack={onBack}
      onSkip={onSkip}
      skipping={skipping}
      formError={formError ?? skipError}
    >
      <div className="setup-section">
        <div className="setup-section__title">Thành viên được mời</div>
        {rows.length === 0 ? (
          <EmptyState icon="ph ph-users-three" title="Chưa mời ai" description="Bỏ trống và tiếp tục cũng được — mời sau ở Điều khiển hệ thống › Quyền hạn." />
        ) : (
          <div className="invite-rows">
            {rows.map((r) => (
              <div className="invite-row" key={r.id}>
                <TextField label="Tên hiển thị" value={r.display_name} onChange={(e) => updateRow(r.id, { display_name: e.target.value })} maxLength={120} />
                <TextField label="Email" type="email" value={r.email} onChange={(e) => updateRow(r.id, { email: e.target.value })} maxLength={320} />
                <SelectField label="Vai trò" value={r.role} onChange={(e) => updateRow(r.id, { role: e.target.value as InviteRole })} options={ROLE_OPTIONS} />
                <Button variant="ghost" className="btn-27 invite-row__remove" icon="ph ph-trash" aria-label="Bỏ dòng này" onClick={() => removeRow(r.id)} />
              </div>
            ))}
          </div>
        )}
        {hasPartial ? <p className="inline-error">Điền đủ tên và email cho từng dòng, hoặc bấm bỏ dòng.</p> : null}
        <Button variant="secondary" icon="ph ph-plus" onClick={addRow} className="btn-27">
          Thêm người
        </Button>
      </div>
    </StepFrame>
  );
}
