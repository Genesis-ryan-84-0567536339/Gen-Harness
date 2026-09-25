import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { SetupState, SetupStepStatus } from '@gen-harness/contracts';
import { ErrorState, Icon, Skeleton } from '@gen-harness/ui';
import { api } from '../lib/api';
import { qk } from '../lib/queries';
import { queryClient } from '../lib/queryClient';
import { useRealtime } from '../lib/realtime';
import { useUrlState } from '../lib/uiStore';
import { Logo } from '../shell/Logo';
import { ComingSoonStep } from './ComingSoonStep';
import { Step1Welcome } from './Step1Welcome';
import { Step2Owner } from './Step2Owner';
import { Step3Org } from './Step3Org';
import { Step4Brain } from './Step4Brain';
import { Step5Channels } from './Step5Channels';
import { Step6Groups } from './Step6Groups';
import { Step7Refinery } from './Step7Refinery';
import { Step10Team } from './Step10Team';
import { Step11Backup } from './Step11Backup';
import { Step12Finish } from './Step12Finish';
import { SETUP_STEPS, STEP_DESCRIPTIONS } from './steps';
import { isReachable, mergeSteps } from './stepState';
import type { StepProps } from './types';
import { describeError } from './types';

const TOKEN_KEY = 'gh_setup_token';

/** Phase-2 steps (docs/api/phase-2.md "Trình thiết lập bước 4–7, 12"). */
const BUILT_STEPS: Record<number, (p: StepProps) => JSX.Element> = {
  4: Step4Brain,
  5: Step5Channels,
  6: Step6Groups,
  7: Step7Refinery,
  10: Step10Team,
  11: Step11Backup,
  12: Step12Finish,
};

function readStoredToken(): string {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}
function storeToken(t: string) {
  try {
    window.sessionStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* private mode: keep it in memory only */
  }
}

export function SetupPage() {
  const [params] = useSearchParams();
  const urlToken = params.get('token') ?? '';
  const [token, setTokenState] = useState(() => urlToken || readStoredToken());
  const [stepParam, setStepParam] = useUrlState<string>('step', '');
  const [skipping, setSkipping] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const state = useQuery({ queryKey: qk.setupState, queryFn: ({ signal }) => api.setup.state(signal) });
  // Live QR / CLI login / first-run progress once the owner is signed in (after step 3).
  useRealtime(!!state.data && !state.data.finished && state.data.current_step >= 4);

  useEffect(() => {
    document.title = 'Thiết lập Owner · Gen-Harness';
  }, []);
  useEffect(() => {
    if (urlToken) {
      storeToken(urlToken);
      setTokenState(urlToken);
    }
  }, [urlToken]);

  const setToken = useCallback((t: string) => {
    storeToken(t);
    setTokenState(t);
  }, []);

  // Enter = Tiếp tục even when focus is not inside a field (docs/06 "Tiếp cận").
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest('button, a, input, select, textarea, [role="dialog"]')) return;
      formRef.current?.requestSubmit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (state.isPending) return <SetupSkeleton />;
  if (state.isError) {
    return (
      <div className="page-center">
        <div className="gh-card" style={{ width: 'min(520px, 100%)' }}>
          <ErrorState
            title="Không tải được trạng thái thiết lập"
            message={describeError(state.error)}
            onRetry={() => void state.refetch()}
            retrying={state.isFetching}
          />
        </div>
      </div>
    );
  }
  if (state.data.finished) return <Navigate to="/overview" replace />;

  const data = state.data;
  const steps = mergeSteps(data);
  const requested = Number(stepParam);
  const view = requested >= 1 && requested <= 12 && isReachable(requested, data) ? requested : data.current_step;
  const current = steps[view - 1];
  const settledCount = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;

  const go = (n: number) => {
    setSkipError(null);
    setStepParam(n === data.current_step ? '' : String(n));
  };
  const onSaved = (s: SetupState) => {
    queryClient.setQueryData(qk.setupState, s);
    setSkipError(null);
    setStepParam('');
  };
  const onBack = view > 1 ? () => go(view - 1) : undefined;
  const onNext = () => go(Math.min(12, view + 1));
  const onSkip = async () => {
    setSkipping(true);
    setSkipError(null);
    try {
      onSaved(await api.setup.skip(view));
    } catch (e) {
      setSkipError(describeError(e));
    } finally {
      setSkipping(false);
    }
  };

  const common = {
    meta: current,
    description: STEP_DESCRIPTIONS[view] ?? current.content,
    status: current.status,
    token,
    setToken,
    onBack,
    onSaved,
    onNext,
    formRef,
    // Bước 10–11 (không bắt buộc) dùng chung nút "Bỏ qua" với ComingSoonStep; các bước khác bỏ qua field này.
    onSkip: !current.required && current.status !== 'done' && current.status !== 'skipped' ? () => void onSkip() : undefined,
    skipping,
    skipError,
  };

  return (
    <div className="setup">
      <aside className="setup-rail" aria-label="Các bước thiết lập">
        <Logo wide />
        <div className="sb-rule" aria-hidden />
        <ol className="setup-steps">
          {steps.map((s) => {
            const reachable = isReachable(s.n, data);
            return (
              <li key={s.n}>
                <button
                  type="button"
                  className="setup-steps__item"
                  data-active={s.n === view || undefined}
                  data-status={s.status}
                  aria-current={s.n === view ? 'step' : undefined}
                  disabled={!reachable}
                  onClick={() => go(s.n)}
                >
                  <span className="setup-steps__num">{String(s.n).padStart(2, '0')}</span>
                  <span className="setup-steps__name">{s.title}</span>
                  <StatusMark status={s.status} />
                </button>
              </li>
            );
          })}
        </ol>
        <div className="setup-progress">
          <div
            className="setup-progress__bar"
            role="progressbar"
            aria-label="Tiến độ thiết lập"
            aria-valuemin={0}
            aria-valuemax={12}
            aria-valuenow={settledCount}
          >
            <span style={{ width: `${(settledCount / 12) * 100}%` }} />
          </div>
          <div className="setup-progress__text">
            Bước {data.current_step}/12
          </div>
        </div>
      </aside>
      <main className="setup-main">
        <div className="setup-content" key={view}>
          {view === 1 ? (
            <Step1Welcome {...common} />
          ) : view === 2 ? (
            <Step2Owner {...common} />
          ) : view === 3 ? (
            <Step3Org {...common} />
          ) : current.available && BUILT_STEPS[view] ? (
            (() => {
              const Step = BUILT_STEPS[view];
              return <Step {...common} />;
            })()
          ) : (
            <ComingSoonStep
              meta={current}
              status={current.status}
              onBack={onBack}
              onNext={onNext}
              onSkip={() => void onSkip()}
              skipping={skipping}
              formError={skipError}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function StatusMark({ status }: { status: SetupStepStatus }) {
  switch (status) {
    case 'done':
      return (
        <span className="setup-steps__mark setup-steps__mark--done">
          <Icon name="ph ph-check" size={12} label="xong" />
        </span>
      );
    case 'doing':
      return (
        <span className="setup-steps__mark">
          <span className="setup-steps__dot" />
          <span className="visually-hidden">đang làm</span>
        </span>
      );
    case 'skipped':
      return <span className="setup-steps__mark setup-steps__mark--skipped">bỏ qua</span>;
    default:
      return (
        <span className="setup-steps__mark setup-steps__mark--todo" aria-label="chưa làm">
          ·
        </span>
      );
  }
}

function SetupSkeleton() {
  return (
    <div className="setup" aria-busy="true">
      <aside className="setup-rail">
        <Logo wide />
        <div className="sb-rule" aria-hidden />
        <div className="setup-steps">
          {SETUP_STEPS.map((s) => (
            <div className="setup-steps__item" key={s.n}>
              <Skeleton width={16} height={10} />
              <Skeleton width={`${45 + ((s.n * 13) % 40)}%`} height={10} />
            </div>
          ))}
        </div>
      </aside>
      <main className="setup-main">
        <div className="setup-content">
          <Skeleton width={200} height={20} />
          <Skeleton width="70%" height={12} style={{ marginTop: 9 }} />
          <div className="gh-card setup-card" style={{ marginTop: 20, height: 260 }} />
        </div>
      </main>
    </div>
  );
}
