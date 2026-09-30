import { useState } from 'react';
import type { SetupState, Step8Agent as Step8Result } from '@gen-harness/contracts';
import { Icon, SelectField, TextField } from '@gen-harness/ui';
import { api } from '../lib/api';
import { StepFrame } from './StepFrame';
import { describeError, type StepProps } from './types';

/** Mẫu agent (docs/handoff/06 bước 8) — chỉ điền sẵn tên/vai trò, Sếp sửa lại tuỳ ý. */
const TEMPLATES: Array<{ value: string; label: string; name: string; role: string }> = [
  { value: '', label: 'Tạo trống', name: '', role: '' },
  { value: 'sales', label: 'Trợ lý thương mại', name: 'Trợ lý Kinh doanh', role: 'Theo dõi nhu cầu mua bán trong nhóm, báo cơ hội và soạn sẵn báo giá chờ duyệt.' },
  { value: 'key_account', label: 'Khách hàng lớn', name: 'Trợ lý Khách hàng lớn', role: 'Chăm sóc khách hàng quan trọng, nhắc lịch hẹn và theo dõi đơn đang mở.' },
  { value: 'ops', label: 'Admin hậu cần', name: 'Trợ lý Hậu cần', role: 'Theo dõi giao nhận, tồn kho và việc đến hạn của đội vận hành.' },
  { value: 'cs', label: 'CSKH', name: 'Trợ lý CSKH', role: 'Trả lời câu hỏi thường gặp, ghi nhận khiếu nại và chuyển việc khó cho người phụ trách.' },
  { value: 'recruiter', label: 'Tuyển dụng', name: 'Trợ lý Tuyển dụng', role: 'Ghi nhận ứng viên, lịch phỏng vấn và nhắc việc tuyển dụng.' },
  { value: 'secretary', label: 'Thư ký cá nhân', name: 'Thư ký', role: 'Tóm tắt tin nhắn quan trọng, nhắc lịch và soạn sẵn trả lời cho Sếp duyệt.' },
];

/** Bước 8 — Agent đầu tiên: tạo agent (PUT /setup/steps/8) và nghe thử một câu trả lời. Gán kênh/nhóm làm sau ở màn Agent. */
export function Step8Agent({ meta, description, onBack, onSaved, formRef, onSkip, skipping, skipError }: StepProps) {
  const [template, setTemplate] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [tryMessage, setTryMessage] = useState('Chào bạn, bạn giới thiệu ngắn về mình và việc bạn sẽ giúp tôi nhé.');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<{ agent: Step8Result; state: SetupState } | null>(null);

  const pickTemplate = (v: string) => {
    setTemplate(v);
    const t = TEMPLATES.find((x) => x.value === v);
    if (t && t.value) {
      setName(t.name);
      setRole(t.role);
    }
  };
  const canContinue = name.trim() !== '' && role.trim() !== '' && tryMessage.trim() !== '';

  const save = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const res = await api.setup.step8({ name: name.trim(), role_desc: role.trim(), template: template || null, try_message: tryMessage.trim() });
      setResult({ agent: res.agent, state: res });
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const { agent, state } = result;
    return (
      <StepFrame n={meta.n} title={meta.title} description={description} canContinue onContinue={() => onSaved(state)} onBack={onBack} continueLabel="Tiếp tục">
        <div className="setup-section">
          <div className="setup-section__title">Đã tạo agent “{agent.name}”</div>
          {agent.try_reply ? (
            <div className="setup-try">
              <div className="setup-try__label">
                <Icon name="ph ph-chat-circle-text" size={14} /> {agent.name} trả lời thử
              </div>
              <p className="setup-try__reply">{agent.try_reply}</p>
            </div>
          ) : (
            <p className="muted-note">
              Agent đã lưu, nhưng chưa trò chuyện thử được: {agent.try_error ?? 'bộ não AI chưa trả lời'}. Thử lại sau ở màn Danh tính Agent.
            </p>
          )}
          <p className="muted-note">Gán kênh và nhóm cho agent làm sau ở màn Danh tính Agent.</p>
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
        <SelectField label="Mẫu" value={template} onChange={(e) => pickTemplate(e.target.value)} options={TEMPLATES.map((t) => ({ value: t.value, label: t.label }))} />
        <TextField label="Tên agent" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
        <TextField label="Vai trò — agent làm gì cho Sếp" value={role} onChange={(e) => setRole(e.target.value)} maxLength={500} required />
        <TextField label="Câu thử trò chuyện" value={tryMessage} onChange={(e) => setTryMessage(e.target.value)} maxLength={1000} required />
      </div>
    </StepFrame>
  );
}
