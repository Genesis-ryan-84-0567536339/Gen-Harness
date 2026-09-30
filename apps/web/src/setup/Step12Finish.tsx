import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { RefineryProgress } from '@gen-harness/contracts';
import { Icon } from '@gen-harness/ui';
import { FOLLOW_UP_KEY } from '../guide/guideContent';
import { api } from '../lib/api';
import { qk2, useChannels, usePipeline, useProviders, useRules, useSchedule } from '../lib/dataQueries';
import { fmtInt, fmtInterval } from '../lib/format';
import { qk } from '../lib/queries';
import { queryClient } from '../lib/queryClient';
import { Bar } from '../screens/common';
import { NoModelNotice } from '../screens/queue/NoModelBanner';
import { ACC4, N5, OK, WARN } from '../screens/data/dataModel';
import { firstRunCounters, missingRequiredSteps, setupGaps } from './phase2Model';
import { StepFrame } from './StepFrame';
import { describeError, type StepProps } from './types';

const STATUS_TEXT = {
  idle: 'Lần sàng lọc đầu tiên sẽ chạy khi hệ thống gom đủ tin hoặc hết chu kỳ đầu.',
  running: 'Hệ thống đang phân loại tin lần đầu…',
  done: 'Lần sàng lọc đầu tiên đã xong.',
  failed: 'Lần sàng lọc đầu tiên gặp lỗi — xem Chu kỳ gần nhất ở Kho dữ liệu thô.',
} as const;

/** Bước 12 — summary + first refinery run live over WebSocket (`refinery.progress`). */
export function Step12Finish({ meta, description, onBack, onSaved, formRef }: StepProps) {
  const providers = useProviders();
  const channels = useChannels();
  const pipeline = usePipeline();
  const rules = useRules();
  const schedule = useSchedule();
  const live = useQuery<RefineryProgress | null>({
    queryKey: qk2.latestProgress,
    queryFn: () => null,
    enabled: false,
    initialData: null,
  });
  const first = useQuery({
    queryKey: qk2.firstRun,
    queryFn: ({ signal }) => api.setup.firstRun(signal),
    // Poll as a fallback while the socket is down; WS progress updates in between.
    refetchInterval: (q) => (q.state.data?.run?.status === 'done' ? false : 5000),
  });
  const c = firstRunCounters(first.data, live.data);
  // Same query as SetupPage (deduplicated): which required steps still block "Hoàn tất".
  const setupState = useQuery({ queryKey: qk.setupState, queryFn: ({ signal }) => api.setup.state(signal) });
  const missing = missingRequiredSteps(setupState.data);
  const followUp = useQuery({ queryKey: FOLLOW_UP_KEY, queryFn: ({ signal }) => api.setup.followUp(signal) });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const finish = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const s = await api.setup.step12();
      void queryClient.invalidateQueries({ queryKey: qk.me });
      void queryClient.invalidateQueries({ queryKey: qk.navigation });
      onSaved(s);
    } catch (e) {
      setFormError(describeError(e));
      setBusy(false);
    }
  };

  const activeChannels = channels.data?.filter((x) => x.state === 'active').map((x) => x.name) ?? [];
  const enabledRules = rules.data?.filter((r) => r.enabled) ?? [];
  const chain = [...(providers.data ?? [])].sort((a, b) => a.failover_rank - b.failover_rank).filter((p) => p.enabled);
  const dash = '…';
  const usable = chain.filter((p) => p.kind !== 'system_one' && p.auth_state === 'ok' && p.models.length > 0);
  const unusable = chain.filter((p) => p.kind !== 'system_one').length - usable.length;
  // v0.1.28 (UX C1/V10): nói thật những gì còn thiếu thay vì "Mọi thứ đã sẵn sàng".
  const gaps = setupGaps({
    providers: providers.data,
    activeChannels: channels.data ? activeChannels.length : undefined,
    groupsListening: pipeline.data?.groups_listening,
    enabledRules: rules.data ? enabledRules.length : undefined,
    backupDone: Array.isArray(followUp.data) ? !!followUp.data.find((i) => i.n === 11)?.done : undefined,
  });
  const loaded = !!(providers.data && channels.data && pipeline.data && rules.data && Array.isArray(followUp.data));

  return (
    <StepFrame
      n={meta.n}
      title={meta.title}
      description={description}
      formRef={formRef}
      canContinue
      busy={busy}
      onContinue={() => void finish()}
      onBack={onBack}
      formError={formError}
      continueLabel="Mở Tổng quan điều hành"
    >
      {missing.length ? (
        <div className="setup-section">
          <div className="risk-box" role="note">
            <Icon name="ph ph-hourglass-medium" size={16} color={WARN} />
            <div>
              <div className="risk-box__title">
                Còn bước bắt buộc chưa xong: {missing.map((m) => m.n).join(', ')}
              </div>
              <p className="risk-box__text">
                Cần xong {missing.map((m) => m.title).join(', ')} trước khi hoàn tất thiết lập. Các bước khác Sếp đã để sau sẽ hiện ở
                "Việc thiết lập tiếp" trên Tổng quan.{' '}
                <Link to="/overview">Vào Console</Link>
              </p>
            </div>
          </div>
        </div>
      ) : null}
      {gaps.some((g) => g.key === 'model') ? (
        <div className="setup-section">
          <NoModelNotice to="/setup?step=4" />
        </div>
      ) : null}
      {loaded ? (
        <div className="setup-section" data-testid="setup-gaps">
          <div className="risk-box" role="note">
            <Icon name={gaps.length ? 'ph ph-list-checks' : 'ph ph-check-circle'} size={16} color={gaps.length ? WARN : OK} />
            <div>
              <div className="risk-box__title">
                {gaps.length ? `Đã lưu — còn ${gaps.length} việc để hệ thống chạy đầy đủ` : 'Mọi thứ đã sẵn sàng'}
              </div>
              {gaps.length ? (
                <ul className="setup-gaps">
                  {gaps.map((g) => (
                    <li key={g.key}>
                      {g.text} — <Link to={`/setup?step=${g.step}`}>làm ở bước {g.step}</Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="risk-box__text">Model AI, kênh, nhóm lắng nghe, quy tắc sàng lọc và sao lưu đều đã bật.</p>
              )}
              {gaps.length ? <p className="risk-box__text">Có thể hoàn tất ngay và làm tiếp sau ở "Việc thiết lập tiếp" trên Tổng quan.</p> : null}
            </div>
          </div>
        </div>
      ) : null}
      <div className="setup-section">
        <div className="setup-section__title">Những gì đã bật</div>
        <div className="summary">
          <span className="summary__k">bộ não AI</span>
          <span className="summary__v">{providers.data ? (usable.length ? `${usable.map((p) => `${p.name} (${p.models[0].model_name})`).join(' → ')}${unusable ? ` · ${unusable} nguồn chưa dùng được (xếp cuối)` : ''}` : 'chưa có nguồn nào dùng được') : dash}</span>
          <span className="summary__k">kênh</span>
          <span className="summary__v">{channels.data ? (activeChannels.length ? activeChannels.join(', ') : 'chưa kết nối') : dash}</span>
          <span className="summary__k">nhóm lắng nghe</span>
          <span className="summary__v">{pipeline.data ? `${fmtInt(pipeline.data.groups_listening)} nhóm` : dash}</span>
          <span className="summary__k">quy tắc sàng lọc</span>
          <span className="summary__v">
            {rules.data ? `${fmtInt(enabledRules.length)} quy tắc${enabledRules.length ? ` · ${enabledRules.map((r) => r.code).join(', ')}` : ''}` : dash}
          </span>
          <span className="summary__k">kích hoạt</span>
          <span className="summary__v">
            {schedule.data ? `mỗi ${fmtInterval(schedule.data.interval_seconds)} hoặc khi vượt ${fmtInt(schedule.data.count_threshold)} bản ghi` : dash}
          </span>
        </div>
      </div>
      <div className="setup-section" aria-live="polite" aria-busy={first.isPending || undefined}>
        <div className="setup-section__title">Lần sàng lọc đầu tiên · thời gian thực</div>
        <div className="first-run">
          <div className="first-run__cell">
            <div className="first-run__label">Bản ghi thô đã gom</div>
            <div className="first-run__value" style={{ color: WARN }}>
              {first.data ? fmtInt(c.raw) : dash}
            </div>
          </div>
          <div className="first-run__cell">
            <div className="first-run__label">Đang phân loại</div>
            <div className="first-run__value" style={{ color: ACC4 }}>
              {first.data || live.data ? fmtInt(c.classifying) : dash}
            </div>
          </div>
          <div className="first-run__cell">
            <div className="first-run__label">Đã vào kho sạch</div>
            <div className="first-run__value" style={{ color: OK }}>
              {first.data || live.data ? fmtInt(c.clean) : dash}
            </div>
          </div>
        </div>
        <div className="dlg-row">
          <Bar pct={c.pct} tone={c.status === 'failed' ? 'var(--color-bad)' : 'var(--color-accent)'} />
          <span className="td-id" style={{ flex: 'none' }}>
            {c.pct}%
          </span>
        </div>
        <p className="setup-section__hint">
          {first.isError ? describeError(first.error) : STATUS_TEXT[c.status]}{' '}
          <span style={{ color: N5 }}>
            Tin cậy thấp {fmtInt(c.lowconf)} · loại nhiễu {fmtInt(c.discarded)}.
          </span>
        </p>
      </div>
    </StepFrame>
  );
}
