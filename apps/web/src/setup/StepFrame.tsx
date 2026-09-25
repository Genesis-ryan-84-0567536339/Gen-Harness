import type { FormEvent, ReactNode, RefObject } from 'react';
import { Button } from '@gen-harness/ui';

export interface StepFrameProps {
  n: number;
  title: string;
  description: string;
  children: ReactNode;
  canContinue: boolean;
  busy?: boolean;
  onContinue: () => void;
  onBack?: () => void;
  /** Present only for optional steps. */
  onSkip?: () => void;
  skipping?: boolean;
  /** Form-level error (network, conflict…). */
  formError?: string | null;
  formRef?: RefObject<HTMLFormElement>;
  continueLabel?: string;
  continueIcon?: string;
  /** Render children without the surface card (steps made of their own cards). */
  bare?: boolean;
}

/** Right pane of the wizard: title, description, surface card, action bar. */
export function StepFrame({
  n,
  title,
  description,
  children,
  canContinue,
  busy,
  onContinue,
  onBack,
  onSkip,
  skipping,
  formError,
  formRef,
  continueLabel = 'Tiếp tục',
  continueIcon = 'ph ph-arrow-right',
  bare,
}: StepFrameProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canContinue && !busy) onContinue();
  };
  return (
    <form ref={formRef} className="setup-step" onSubmit={submit} noValidate aria-labelledby={`setup-step-${n}-title`}>
      <div className="setup-step__head">
        <h1 className="screen-title" id={`setup-step-${n}-title`}>
          {title}
        </h1>
        <p className="screen-desc">{description}</p>
      </div>
      {bare ? <div className="setup-bare">{children}</div> : <div className="gh-card setup-card">{children}</div>}
      <div className="setup-error" role="alert" aria-live="assertive">
        {formError}
      </div>
      <div className="setup-actions">
        <Button variant="ghost" icon="ph ph-arrow-left" onClick={onBack} disabled={!onBack}>
          Quay lại
        </Button>
        <span className="setup-actions__spacer" />
        {onSkip ? (
          <Button variant="secondary" onClick={onSkip} loading={skipping}>
            Bỏ qua
          </Button>
        ) : null}
        <Button variant="primary" type="submit" disabled={!canContinue} loading={busy} iconRight={continueIcon}>
          {continueLabel}
        </Button>
      </div>
    </form>
  );
}
