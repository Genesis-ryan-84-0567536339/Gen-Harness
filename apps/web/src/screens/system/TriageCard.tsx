import { useEffect, useState } from 'react';
import { Button, Switch, TextField } from '@gen-harness/ui';
import { errorText } from '../../lib/errorText';
import { useMe } from '../../lib/queries';
import { CardError, InlineError, Panel, SkeletonLines } from '../common';
import { useSetTriageSettings, useTriageSettings, useTriageSummary } from '../queue/queries';

/**
 * Lọc đầu Hộp thư (v0.1.25, ROADMAP Đợt C1): job nền đánh dấu mục trùng, rác và chấm điểm 0–100 (Jev khi có, quy tắc
 * khi không). Owner bật/tắt, đặt ngưỡng điểm, chọn có dùng Jev; vai trò khác chỉ xem. Mọi thay đổi ghi Nhật ký hành động.
 */
export function TriageCard() {
  const me = useMe();
  const isOwner = me.data?.role?.code === 'owner';
  const settings = useTriageSettings();
  const summary = useTriageSummary(7);
  const save = useSetTriageSettings();
  const [score, setScore] = useState('');
  useEffect(() => {
    if (settings.data) setScore(String(settings.data.min_score));
  }, [settings.data]);
  const n = Number(score);
  const scoreValid = score.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 100;
  const s = summary.data;

  return (
    <Panel title="Lọc đầu Hộp thư" kicker="Trùng · rác · điểm 0–100 — Jev hoặc quy tắc" label="Lọc đầu Hộp thư" genTarget="system.brain.triage" bodyClass="jev-body">
      {settings.isPending ? (
        <SkeletonLines rows={3} padding="0" />
      ) : settings.isError ? (
        <CardError error={settings.error} onRetry={() => void settings.refetch()} retrying={settings.isFetching} />
      ) : (
        <>
          <div className="triage-row">
            <Switch
              checked={settings.data.enabled}
              label="Bật lọc đầu"
              disabled={!isOwner || save.isPending}
              onChange={(v) => save.mutate({ enabled: v })}
            />
            <span>Bật lọc đầu</span>
          </div>
          <div className="triage-row">
            <Switch
              checked={settings.data.use_jev}
              label="Dùng Jev để chấm"
              disabled={!isOwner || save.isPending}
              onChange={(v) => save.mutate({ use_jev: v })}
            />
            <span>Dùng Jev để chấm (không có Jev thì dùng quy tắc)</span>
          </div>
          <form
            className="jev-actions"
            onSubmit={(e) => {
              e.preventDefault();
              if (scoreValid && isOwner) save.mutate({ min_score: n });
            }}
          >
            <TextField label="Ngưỡng điểm (0–100)" type="number" value={score} disabled={!isOwner} onChange={(e) => setScore(e.target.value)} />
            {isOwner ? (
              <Button variant="secondary" type="submit" className="btn-27" disabled={!scoreValid || n === settings.data.min_score} loading={save.isPending}>
                Lưu ngưỡng
              </Button>
            ) : null}
          </form>
          {!isOwner ? <p className="muted-note">Chỉ Sếp (Owner) thay đổi được cấu hình này.</p> : null}
          {save.isError ? <InlineError>{errorText(save.error)}</InlineError> : null}
          {s ? (
            <p className="jev-note" role="status">
              7 ngày: {s.total} mục đã lọc · {s.duplicates} trùng · {s.spam} rác · {s.low_score} điểm thấp · {s.pending} chờ lọc
              {s.jev.count ? ` · Jev ${s.jev.count} lượt${s.jev.avg_latency_ms != null ? `, ~${s.jev.avg_latency_ms} ms` : ''}` : ''}
            </p>
          ) : null}
        </>
      )}
    </Panel>
  );
}
