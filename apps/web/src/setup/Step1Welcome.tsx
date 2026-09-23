import { useState } from 'react';
import { ApiError } from '@gen-harness/contracts';
import { Icon, Segmented, TextField } from '@gen-harness/ui';
import { api } from '../lib/api';
import { StepFrame } from './StepFrame';
import { describeError, TOKEN_INVALID, type StepProps } from './types';
import { useFieldErrors } from './useFieldErrors';
import { isComplete, step1Errors, type Step1Values } from './validation';

const MODES: Array<{ value: Step1Values['mode']; title: string; desc: string; icon: string }> = [
  {
    value: 'empty',
    title: 'Bắt đầu trống',
    desc: 'Console trống, dữ liệu đến từ các kênh Sếp kết nối ở bước 5.',
    icon: 'ph ph-rocket-launch',
  },
  {
    value: 'sample',
    title: 'Dùng dữ liệu mẫu',
    desc: 'Nạp dữ liệu mẫu để xem Console vận hành; xoá được sau ở Điều khiển hệ thống.',
    icon: 'ph ph-database',
  },
];

export function Step1Welcome({ meta, description, status, token, setToken, onSaved, onNext, formRef }: StepProps) {
  const [v, setV] = useState<Step1Values>({ token, language: 'vi', mode: 'empty' });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const clientErrors = step1Errors(v);
  const f = useFieldErrors<keyof Step1Values>(clientErrors);
  const done = status === 'done';

  const save = async () => {
    f.setSubmitted(true);
    if (!isComplete(clientErrors)) return;
    setBusy(true);
    setFormError(null);
    try {
      const body = { ...v, token: v.token.trim() };
      const state = await api.setup.step1(body);
      setToken(body.token);
      onSaved(state);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'SETUP_TOKEN_INVALID' || e.status === 403)) f.setServer({ token: TOKEN_INVALID });
      else if (e instanceof ApiError && e.status === 422) f.setServer(e.fieldErrors as Partial<Record<keyof Step1Values, string>>);
      else setFormError(describeError(e));
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
      canContinue={done || (isComplete(clientErrors) && !f.hasServerErrors)}
      busy={busy}
      onContinue={done ? onNext : () => void save()}
      formError={formError}
    >
      {done ? (
        <div className="setup-done">
          <Icon name="ph ph-check-circle" size={16} color="var(--color-ok)" />
          Mã thiết lập đã được xác nhận. Tiếp tục để tạo tài khoản Owner.
        </div>
      ) : (
        <div className="setup-fields">
          <TextField
            label="Mã thiết lập"
            className="gh-input setup-mono"
            value={v.token}
            autoFocus={!v.token}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setV({ ...v, token: e.target.value });
              f.changed('token');
            }}
            onBlur={() => f.blur('token')}
            error={f.errorOf('token')}
            hint="Hiện trong trình cài (TUI) — tự điền khi mở từ đường dẫn của trình cài."
          />
          <div className="gh-field">
            <span className="gh-field__label" id="setup-lang-label">
              Ngôn ngữ giao diện
            </span>
            <Segmented
              label="Ngôn ngữ giao diện"
              value={v.language}
              onChange={(language) => setV({ ...v, language })}
              options={[
                { value: 'vi', label: 'Tiếng Việt' },
                { value: 'en', label: 'English' },
              ]}
              className="setup-seg"
            />
          </div>
          <fieldset className="setup-options">
            <legend className="gh-field__label">Cách bắt đầu</legend>
            {MODES.map((m) => (
              <label key={m.value} className="setup-option" data-checked={v.mode === m.value || undefined}>
                <input
                  type="radio"
                  name="mode"
                  value={m.value}
                  checked={v.mode === m.value}
                  onChange={() => setV({ ...v, mode: m.value })}
                />
                <span className="setup-option__icon" aria-hidden>
                  <Icon name={m.icon} size={16} />
                </span>
                <span className="setup-option__text">
                  <span className="setup-option__title">{m.title}</span>
                  <span className="setup-option__desc">{m.desc}</span>
                </span>
                <span className="setup-option__radio" aria-hidden />
              </label>
            ))}
          </fieldset>
        </div>
      )}
    </StepFrame>
  );
}
