import { useEffect, useRef } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@gen-harness/ui';
import { api } from '../lib/api';
import { qk } from '../lib/queries';
import { queryClient } from '../lib/queryClient';
import { toast } from '../lib/toast';
import { CardError, SkeletonLines } from '../screens/common';
import { Step4Brain } from '../setup/Step4Brain';
import { Step5Channels } from '../setup/Step5Channels';
import { Step6Groups } from '../setup/Step6Groups';
import { Step7Refinery } from '../setup/Step7Refinery';
import { Step8Agent } from '../setup/Step8Agent';
import { Step9Autonomy } from '../setup/Step9Autonomy';
import { Step10Team } from '../setup/Step10Team';
import { Step11Backup } from '../setup/Step11Backup';
import { STEP_DESCRIPTIONS } from '../setup/steps';
import { mergeSteps } from '../setup/stepState';
import type { StepProps } from '../setup/types';
import { FOLLOW_UP_KEY, GUIDE_BY_N } from './guideContent';

const STEPS: Record<number, (p: StepProps) => JSX.Element> = {
  4: Step4Brain,
  5: Step5Channels,
  6: Step6Groups,
  7: Step7Refinery,
  8: Step8Agent,
  9: Step9Autonomy,
  10: Step10Team,
  11: Step11Backup,
};

/**
 * `/guide/:n` — mở đúng form của trình thiết lập cho việc n (5–11) ngay trong Console, kể cả sau Hoàn tất (API cho
 * phép lưu lại các bước tuỳ chọn). Lưu xong quay về trang Hướng dẫn, việc đó tự hiện "Đã xong".
 */
export function GuideStepPage() {
  const n = Number(useParams().n);
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement>(null);
  const state = useQuery({ queryKey: qk.setupState, queryFn: ({ signal }) => api.setup.state(signal) });
  const guide = GUIDE_BY_N[n];

  useEffect(() => {
    if (guide) document.title = `${guide.title} · Hướng dẫn kết nối · Gen-Harness`;
  }, [guide]);

  const Step = STEPS[n];
  if (!Step || !guide) return <Navigate to="/guide" replace />;

  // Bước 4 (chọn model) mở từ dải "Chưa có model" ở Tổng quan — quay về đó.
  const home = n === 4 ? { to: '/overview', label: 'Tổng quan điều hành' } : { to: '/guide', label: 'Hướng dẫn kết nối' };
  const back = () => navigate(home.to);
  const meta = mergeSteps(state.data).find((s) => s.n === n)!;

  return (
    <div className="screen guide-step">
      <Link to={home.to} className="guide-back">
        <Icon name="ph ph-arrow-left" size={13} /> {home.label}
      </Link>
      {state.isPending ? (
        <div className="gh-card">
          <SkeletonLines rows={6} />
        </div>
      ) : state.isError ? (
        <div className="gh-card">
          <CardError error={state.error} onRetry={() => void state.refetch()} retrying={state.isFetching} />
        </div>
      ) : (
        <div className="setup-content">
          <Step
            meta={meta}
            description={STEP_DESCRIPTIONS[n] ?? guide.why}
            status={meta.status}
            token=""
            setToken={() => undefined}
            onBack={back}
            onNext={back}
            onSaved={(s) => {
              queryClient.setQueryData(qk.setupState, s);
              void queryClient.invalidateQueries({ queryKey: FOLLOW_UP_KEY });
              toast(`Đã xong: ${guide.title}`, 'ok');
              back();
            }}
            formRef={formRef}
          />
        </div>
      )}
    </div>
  );
}
