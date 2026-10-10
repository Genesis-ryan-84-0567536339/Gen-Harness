import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { SystemHealth } from '@gen-harness/contracts';
import { useCan, useOrgTimezone } from '../../lib/permissions';
import { useMe } from '../../lib/queries';
import { useNow } from '../../lib/useNow';
import { CardError, Panel, SkeletonLines } from '../common';
import { TONE_COLOR, healthRows, healthTechRows, healthTips } from './healthModel';
import { useSystemHealth } from './queries';

/**
 * v0.1.36 (F-6): thẻ "Sức khoẻ hệ thống" đầu Điều khiển hệ thống › Dữ liệu & lưu trữ — Bộ xử lý nền, Trình duyệt nền,
 * hàng lỗi (DLQ), sao lưu, cập nhật, ổ đĩa, tự cập nhật đêm (`GET /system/health`); "Chi tiết kỹ thuật" liệt kê lịch
 * chạy và từng hàng lỗi. Chỉ vai trò có `system.read`. Hướng dẫn từng bước (`healthTips`, kể cả "Cách bật lại lịch tự
 * cập nhật đêm" — đích của nút "Xem cách bật lại") hiện ngay dưới các dòng.
 */
export function HealthCard() {
  const canRead = useCan('system.read');
  const tz = useOrgTimezone();
  const now = useNow(30_000);
  const q = useSystemHealth(canRead);
  // Dải "Cần Sếp xử lý" (job.timeout → `/system?tab=storage&focus=health`, nút "Xem sức khoẻ"): cuộn tới thẻ này.
  const [params] = useSearchParams();
  const focusHealth = params.get('focus') === 'health';
  const focused = useRef(false);
  useEffect(() => {
    if (!focusHealth || focused.current || !q.data) return;
    focused.current = true;
    const panel = document.querySelector<HTMLElement>('[data-gen-target="system.storage.health"]');
    if (!panel) return;
    panel.scrollIntoView?.({ block: 'start' });
    panel.setAttribute('tabindex', '-1');
    panel.focus({ preventScroll: true });
  }, [focusHealth, q.data]);
  if (!canRead) return null;
  return (
    <Panel genTarget="system.storage.health" title="Sức khoẻ hệ thống" kicker="Tự kiểm mỗi phút" label="Sức khoẻ hệ thống" bodyClass="health-card" className="health-card-panel">
      {q.isPending ? (
        <SkeletonLines rows={6} padding="0" />
      ) : q.isError ? (
        <CardError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <HealthBody data={q.data} now={now} tz={tz} />
      )}
    </Panel>
  );
}

function HealthBody({ data, now, tz }: { data: SystemHealth; now: number; tz: string }) {
  const canManage = useCan('system.manage');
  const isOwner = useMe().data?.role?.code === 'owner';
  const rows = healthRows(data, now, tz, { isOwner, canManage });
  const tech = healthTechRows(data, tz);
  const tips = healthTips(data);
  return (
    <>
      <ul className="health-card__rows">
        {rows.map((r) => (
          <li className="health-card__row" key={r.key} data-tone={r.tone} data-testid={`health-${r.key}`}>
            <span className="health-card__dot" style={{ background: TONE_COLOR[r.tone] }} aria-hidden />
            <span className="health-card__label">{r.label}</span>
            <span className="health-card__value" style={r.tone === 'bad' || r.tone === 'warn' ? { color: TONE_COLOR[r.tone] } : undefined}>
              {r.value}
            </span>
            {r.hint ? <span className="health-card__hint">{r.hint}</span> : null}
          </li>
        ))}
      </ul>
      {tips.map((t) => (
        <div className="health-card__tip" key={t.key} data-testid={`health-tip-${t.key}`} role="note" aria-label={t.title}>
          <div className="health-card__tip-title">{t.title}</div>
          <ol className="health-card__tip-steps">
            {t.steps.map((st, i) => (
              <li key={i}>
                {st.text}
                {st.cmd ? (
                  <>
                    {' '}
                    <code className="mono">{st.cmd}</code>
                  </>
                ) : null}
              </li>
            ))}
          </ol>
          {t.warning ? <p className="health-card__tip-warn">{t.warning}</p> : null}
        </div>
      ))}
      <details className="tech-detail health-card__tech">
        <summary>Chi tiết kỹ thuật</summary>
        <div className="health-card__tech-title">Lịch chạy</div>
        {tech.crons.length === 0 ? (
          <p className="muted-note">Chưa có lịch chạy nào ghi nhận.</p>
        ) : (
          <ul className="health-card__tech-list">
            {tech.crons.map((c) => (
              <li key={c.name}>
                <code className="mono">{c.name}</code>
                <span style={{ color: TONE_COLOR[c.tone] }}>{c.value}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="health-card__tech-title">Hàng lỗi (DLQ)</div>
        {tech.queues.length === 0 ? (
          <p className="muted-note">Không có hàng lỗi.</p>
        ) : (
          <ul className="health-card__tech-list">
            {tech.queues.map((x) => (
              <li key={x.name}>
                <code className="mono">{x.name}</code>
                <span style={{ color: TONE_COLOR[x.tone] }}>{x.value}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </>
  );
}
