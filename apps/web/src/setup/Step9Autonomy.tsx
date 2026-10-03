import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AUTONOMY_LEVELS } from '@gen-harness/contracts';
import { Icon, Segmented } from '@gen-harness/ui';
import { api } from '../lib/api';
import { StepFrame } from './StepFrame';
import { describeError, type StepProps } from './types';

const LEVEL_OPTIONS = [3, 4].map((n) => ({ value: String(n), label: `${n} · ${AUTONOMY_LEVELS[n]}` }));

/** Bước 9 — Tự trị & ranh giới: mức 3 hoặc 4 cho agent vừa tạo, xác nhận đã đọc ranh giới khoá cứng (không tắt được). */
export function Step9Autonomy({ meta, description, onBack, onSaved, formRef, onSkip, skipping, skipError }: StepProps) {
  const boundaries = useQuery({ queryKey: ['setup', 'hard-boundaries'], queryFn: ({ signal }) => api.setup.hardBoundaries(signal) });
  const [level, setLevel] = useState('4');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setFormError(null);
    try {
      onSaved(await api.setup.step9({ autonomy_level: level === '3' ? 3 : 4, ack_boundaries: ack }));
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepFrame
      n={meta.n}
      title={meta.title}
      description={description}
      formRef={formRef}
      canContinue={ack}
      busy={busy}
      onContinue={() => void save()}
      onBack={onBack}
      onSkip={onSkip}
      skipping={skipping}
      formError={formError ?? skipError}
    >
      <div className="setup-section">
        <div className="setup-section__title">Mức tự trị của agent</div>
        <Segmented label="Mức tự trị" value={level} onChange={setLevel} options={LEVEL_OPTIONS} />
        <p className="muted-note">Mức 4: agent soạn sẵn, Sếp duyệt rồi mới gửi. Mức 3: agent chỉ gợi ý. Đổi lại bất cứ lúc nào ở màn Danh tính Agent.</p>
      </div>
      <div className="setup-section">
        <div className="setup-section__title">Ranh giới khoá cứng — không tắt được</div>
        <ul className="setup-boundaries">
          {(boundaries.data ?? []).map((b) => (
            <li key={b}>
              <Icon name="ph ph-lock-simple" size={13} /> {b}
            </li>
          ))}
        </ul>
        <label className="setup-ack">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Tôi đã đọc các ranh giới trên
        </label>
      </div>
    </StepFrame>
  );
}
