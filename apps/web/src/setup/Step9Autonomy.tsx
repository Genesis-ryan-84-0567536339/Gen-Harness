import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AUTONOMY_CHOICES, PinCancelledError } from '@gen-harness/contracts';
import { Icon, Segmented } from '@gen-harness/ui';
import { api } from '../lib/api';
import { errorText } from '../lib/errorText';
import { qk } from '../lib/queries';
import { PinHint } from '../screens/common';
import { StepFrame } from './StepFrame';
import { describeError, type StepProps } from './types';

// F-30: nhãn 3 mức (không tiền tố số); giá trị gửi vẫn là 3/4 trên thang 0–6.
const LEVEL_OPTIONS = AUTONOMY_CHOICES.filter((c) => c.level === 3 || c.level === 4).map((c) => ({ value: String(c.level), label: c.label }));

const PIN_TEXT = 'Sau Hoàn tất, đổi mức tự trị cần mã PIN';

/** Bước 9 — Tự trị & ranh giới: mức 3 hoặc 4 cho agent vừa tạo, xác nhận đã đọc ranh giới khoá cứng (không tắt được). */
export function Step9Autonomy({ meta, description, onBack, onSaved, formRef, onSkip, skipping, skipError }: StepProps) {
  const boundaries = useQuery({ queryKey: ['setup', 'hard-boundaries'], queryFn: ({ signal }) => api.setup.hardBoundaries(signal) });
  const [level, setLevel] = useState('4');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // v0.1.45 (F-20): mở lại từ trang Hướng dẫn SAU Hoàn tất → máy chủ đòi phiên PIN (hộp PIN tự mở khi gặp 423).
  const finished = useQuery({ queryKey: qk.setupState, queryFn: ({ signal }) => api.setup.state(signal) }).data?.finished === true;

  const save = async () => {
    setBusy(true);
    setFormError(null);
    try {
      onSaved(await api.setup.step9({ autonomy_level: level === '3' ? 3 : 4, ack_boundaries: ack }));
    } catch (e) {
      // v0.1.45: huỷ hộp PIN → câu chung 'Đã huỷ — thao tác cần mã PIN.' (errorText), lỗi khác như cũ.
      setFormError(e instanceof PinCancelledError ? errorText(e) : describeError(e));
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
        {finished ? <PinHint text={PIN_TEXT} title={PIN_TEXT} /> : null}
        <p className="muted-note">Soạn sẵn chờ duyệt: agent soạn sẵn, Sếp duyệt rồi mới gửi. Gợi ý: agent chỉ gợi ý việc nên làm. Đổi lại bất cứ lúc nào ở màn Danh tính Agent.</p>
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
