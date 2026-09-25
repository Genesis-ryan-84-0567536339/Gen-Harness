import { useEffect, useState } from 'react';
import { Segmented, TextField } from '@gen-harness/ui';
import { api } from '../lib/api';
import { StepFrame } from './StepFrame';
import { describeError, type StepProps } from './types';

type Frequency = 'daily' | 'weekly' | 'monthly';
type Destination = 'local' | 's3' | 'minio';

const FREQUENCY_OPTIONS: Array<{ value: Frequency; label: string }> = [
  { value: 'daily', label: 'Hằng ngày' },
  { value: 'weekly', label: 'Hằng tuần' },
  { value: 'monthly', label: 'Hằng tháng' },
];
const DESTINATION_OPTIONS: Array<{ value: Destination; label: string }> = [
  { value: 'local', label: 'Trong máy' },
  { value: 's3', label: 'S3-compatible' },
  { value: 'minio', label: 'MinIO nội bộ' },
];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Bước 11 — Sao lưu (tuỳ chọn, PLAN 4.6). Chỉ lưu LỊCH/ĐÍCH; `pg_dump`/MinIO thật là GĐ 5 mục 5.6. */
export function Step11Backup({ meta, description, onBack, onSaved, formRef, onSkip, skipping, skipError }: StepProps) {
  const [frequency, setFrequency] = useState<Frequency>('daily');
  const [timeOfDay, setTimeOfDay] = useState('02:00');
  const [retentionCount, setRetentionCount] = useState('7');
  const [destination, setDestination] = useState<Destination>('local');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [timeTouched, setTimeTouched] = useState(false);

  useEffect(() => setFormError(null), [frequency, timeOfDay, retentionCount, destination]);

  const timeInvalid = timeTouched && !TIME_RE.test(timeOfDay);
  const n = Number(retentionCount);
  const canContinue = TIME_RE.test(timeOfDay) && Number.isInteger(n) && n >= 1 && n <= 365;

  const save = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const state = await api.setup.step11({ frequency, time_of_day: timeOfDay, retention_count: n, destination });
      onSaved(state);
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
      canContinue={canContinue}
      busy={busy}
      onContinue={() => void save()}
      onBack={onBack}
      onSkip={onSkip}
      skipping={skipping}
      formError={formError ?? skipError}
    >
      <div className="setup-section">
        <div className="setup-section__title">Lịch sao lưu</div>
        <div className="setup-grid">
          <div className="seg-field">
            <span className="seg-field__label">Tần suất</span>
            <Segmented label="Tần suất sao lưu" value={frequency} onChange={(v) => setFrequency(v as Frequency)} options={FREQUENCY_OPTIONS} />
          </div>
          <TextField
            label="Giờ chạy (HH:MM)"
            value={timeOfDay}
            onChange={(e) => setTimeOfDay(e.target.value)}
            onBlur={() => setTimeTouched(true)}
            error={timeInvalid ? 'Giờ chạy sao lưu dạng HH:MM (00:00–23:59)' : null}
            placeholder="02:00"
            maxLength={5}
          />
        </div>
      </div>
      <div className="setup-section">
        <div className="setup-section__title">Đích lưu &amp; giữ bao lâu</div>
        <div className="setup-grid">
          <div className="seg-field">
            <span className="seg-field__label">Nơi lưu</span>
            <Segmented label="Đích sao lưu" value={destination} onChange={(v) => setDestination(v as Destination)} options={DESTINATION_OPTIONS} />
          </div>
          <TextField label="Giữ bao nhiêu bản" type="number" min={1} max={365} value={retentionCount} onChange={(e) => setRetentionCount(e.target.value)} />
        </div>
        <p className="muted-note">Chạy sao lưu thật (pg_dump + MinIO, mã hoá, vòng 7 ngày/4 tuần/12 tháng) là việc của trình cài đặt sau khi Console đã chạy — ở đây chỉ đặt trước lịch và đích.</p>
      </div>
    </StepFrame>
  );
}
