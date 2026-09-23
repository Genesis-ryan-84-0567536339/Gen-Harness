import { EmptyState } from '@gen-harness/ui';
import type { StepMeta } from './steps';
import { StepFrame } from './StepFrame';

export interface ComingSoonStepProps {
  meta: StepMeta;
  status: string;
  onBack?: () => void;
  onSkip?: () => void;
  skipping?: boolean;
  onNext: () => void;
  formError?: string | null;
}

/** Steps 4–12 in phase 1: title + description from docs/handoff/06, "Sắp có". */
export function ComingSoonStep({ meta, status, onBack, onSkip, skipping, onNext, formError }: ComingSoonStepProps) {
  const settled = status === 'done' || status === 'skipped';
  return (
    <StepFrame
      n={meta.n}
      title={meta.title}
      description={meta.content}
      canContinue={settled}
      onContinue={onNext}
      onBack={onBack}
      onSkip={!meta.required && !settled ? onSkip : undefined}
      skipping={skipping}
      formError={formError}
    >
      <EmptyState
        icon="ph ph-hourglass-medium"
        title="Sắp có"
        description={
          settled
            ? `Bước này đã ${status === 'skipped' ? 'được bỏ qua' : 'hoàn tất'}. Chỉnh lại được sau ở màn tương ứng của Console.`
            : 'Bước này được dựng ở giai đoạn sau của Gen-Harness.'
        }
      />
      <div className="setup-when">
        <span className="setup-when__key">hoàn thành khi</span>
        <span className="setup-when__val">{meta.doneWhen}</span>
        <span className="setup-when__key">bắt buộc</span>
        <span className="setup-when__val">{meta.required ? 'có' : 'không — bỏ qua được'}</span>
      </div>
    </StepFrame>
  );
}
