import type { SystemHealth } from '@gen-harness/contracts';
import { useCan, useOrgTimezone } from '../../lib/permissions';
import { useNow } from '../../lib/useNow';
import { CardError, Panel, SkeletonLines } from '../common';
import { TONE_COLOR, healthRows, healthTechRows } from './healthModel';
import { useSystemHealth } from './queries';

/**
 * v0.1.36 (F-6): thẻ "Sức khoẻ hệ thống" đầu Điều khiển hệ thống › Dữ liệu & lưu trữ — Bộ xử lý nền, Trình duyệt nền,
 * hàng lỗi (DLQ), sao lưu, cập nhật, ổ đĩa (`GET /system/health`); "Chi tiết kỹ thuật" liệt kê lịch chạy và từng hàng
 * lỗi. Chỉ vai trò có `system.read`.
 */
export function HealthCard() {
  const canRead = useCan('system.read');
  const tz = useOrgTimezone();
  const now = useNow(30_000);
  const q = useSystemHealth(canRead);
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
  const rows = healthRows(data, now, tz);
  const tech = healthTechRows(data, tz);
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
          </li>
        ))}
      </ul>
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
        <div className="health-card__tech-title">Hàng lỗi</div>
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
