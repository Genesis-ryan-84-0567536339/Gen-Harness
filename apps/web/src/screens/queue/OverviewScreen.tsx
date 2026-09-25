import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import type { KpiItem, QueueWidgetItem, SpotlightItem } from '@gen-harness/contracts';
import { EmptyState, Icon, Skeleton } from '@gen-harness/ui';
import { fmtAgo, fmtDMClock, fmtDec, fmtInt, fmtPct } from '../../lib/format';
import { CardError, Panel, SkeletonLines } from '../common';
import { N5, OK, SPOTLIGHT_DIMENSION_LABEL, WARN, initialsOf, queueKindIcon, queueKindTone, QUEUE_ACTION_LABEL, QUEUE_KIND_LABEL } from './queueModel';
import { useOverview } from './queries';

const KPI_ICON: Record<string, string> = {
  channels_live: 'ph ph-broadcast',
  groups_listening: 'ph ph-users-three',
  events_today: 'ph ph-lightning',
  plugins_health: 'ph ph-puzzle-piece',
  processing_latency: 'ph ph-timer',
  pending_ratio: 'ph ph-hourglass-medium',
  time_to_contact: 'ph ph-target',
  quotations_sent: 'ph ph-file-text',
  opportunity_claim_rate: 'ph ph-handshake',
  chassis_latency: 'ph ph-cpu',
  active_profiles: 'ph ph-identification-card',
};

function statusTone(s: KpiItem['status']): string {
  return s === 'bad' ? 'var(--color-bad)' : s === 'warn' ? WARN : OK;
}

function KpiCard({ k }: { k: KpiItem }) {
  const body = (
    <>
      <div className="ov-kpi__head">
        <Icon name={KPI_ICON[k.key] ?? 'ph ph-gauge'} size={14} color={N5} />
        <span className="ov-kpi__label">{k.label}</span>
      </div>
      <div className="ov-kpi__value">
        {k.value === null ? '—' : typeof k.value === 'number' ? (Number.isInteger(k.value) ? fmtInt(k.value) : fmtDec(k.value, 1)) : k.value}
        {k.unit ? <span className="ov-kpi__unit"> {k.unit}</span> : null}
      </div>
      {k.sublabel ? <div className="ov-kpi__sub">{k.sublabel}</div> : null}
      <span className="ov-kpi__bar" style={{ background: statusTone(k.status) } as CSSProperties} aria-hidden />
    </>
  );
  if (!k.filter) return <div className="ov-kpi">{body}</div>;
  return (
    <Link to={`/${k.filter.screen}${qs(k.filter.filters)}`} className="ov-kpi ov-kpi--link">
      {body}
    </Link>
  );
}

function qs(filters: Record<string, string>): string {
  const entries = Object.entries(filters ?? {});
  if (!entries.length) return '';
  return `?${new URLSearchParams(entries).toString()}`;
}

const QUEUE_HREF: Record<QueueWidgetItem['kind'], (i: QueueWidgetItem) => string> = {
  opportunity: () => '/inbox?tab=opportunity',
  alert: () => '/inbox?tab=alert',
  draft: (i) => `/workbench?id=${encodeURIComponent(i.id)}`,
  due: () => '/tasks',
};

function QueueRow({ item }: { item: QueueWidgetItem }) {
  return (
    <div className="ov-queue-row">
      <span className="ov-queue-row__tag" style={{ color: queueKindTone(item.kind), borderColor: queueKindTone(item.kind) }}>
        <Icon name={queueKindIcon(item.kind)} size={11} />
        {QUEUE_KIND_LABEL[item.kind]}
      </span>
      <div className="ov-queue-row__body">
        <div className="ov-queue-row__title">{item.title}</div>
        <div className="ov-queue-row__meta">
          {item.code ? <span className="mono">{item.code}</span> : null}
          <span>{item.due_at ? `hạn ${fmtDMClock(item.due_at)}` : fmtAgo(item.at)}</span>
        </div>
      </div>
      <span className="ov-queue-row__prio" data-p={item.priority}>
        {item.priority}
      </span>
      <Link to={QUEUE_HREF[item.kind](item)} className="ov-queue-row__action">
        {QUEUE_ACTION_LABEL[item.kind]}
        <Icon name="ph ph-arrow-right" size={11} />
      </Link>
    </div>
  );
}

function SpotlightRow({ s }: { s: SpotlightItem }) {
  return (
    <Link to={`/profile?id=${encodeURIComponent(s.person.id)}`} className="ov-spot-row">
      <span className="ov-spot-row__avatar" aria-hidden>
        {initialsOf(s.person.name)}
      </span>
      <div className="ov-spot-row__body">
        <div className="ov-spot-row__name">{s.person.name}</div>
        <div className="ov-spot-row__why">{SPOTLIGHT_DIMENSION_LABEL[s.dimension] ?? s.dimension}</div>
      </div>
      <span className="ov-spot-row__value">{fmtDec(s.value, 0)}</span>
    </Link>
  );
}

function HourlyChart({ hourly }: { hourly: { hour: string; count: number }[] }) {
  const max = Math.max(1, ...hourly.map((h) => h.count));
  return (
    <div className="ov-hourly" role="img" aria-label="Số sự kiện theo giờ trong 24 giờ qua">
      {hourly.map((h) => (
        <span
          key={h.hour}
          className="ov-hourly__bar"
          style={{ height: `${Math.max(2, (h.count / max) * 100)}%` }}
          title={`${h.hour} — ${fmtInt(h.count)} sự kiện`}
        />
      ))}
    </div>
  );
}

export function OverviewScreen() {
  const q = useOverview();

  if (q.isPending) {
    return (
      <div className="screen">
        <div className="ov-kpi-row">
          {Array.from({ length: 6 }, (_, i) => (
            <div className="ov-kpi" key={i}>
              <Skeleton width={90} height={10} />
              <Skeleton width={50} height={22} style={{ marginTop: 8 }} />
            </div>
          ))}
        </div>
        <SkeletonLines rows={6} />
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="screen">
        <CardError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      </div>
    );
  }
  const d = q.data;
  const row1 = d.kpis.filter((k) => k.row === 1);
  const row2 = d.kpis.filter((k) => k.row === 2);

  return (
    <div className="screen">
      <div className="ov-kpi-row">
        {row1.map((k) => (
          <KpiCard key={k.key} k={k} />
        ))}
      </div>
      <div className="ov-kpi-row">
        {row2.map((k) => (
          <KpiCard key={k.key} k={k} />
        ))}
      </div>

      <div className="ov-main-grid">
        <Panel
          title="Hàng đợi cần xử lý"
          kicker="Cơ hội · cảnh báo · chờ duyệt · việc đến hạn — ưu tiên trước"
          aside={
            <Link to="/inbox" className="gh-btn gh-btn--secondary btn-24">
              Mở hộp thư ý nghĩa
              <Icon name="ph ph-arrow-right" size={12} />
            </Link>
          }
          bodyClass="ov-queue-list"
        >
          {d.queue.length === 0 ? (
            <EmptyState icon="ph ph-check-circle" title="Không có gì cần xử lý ngay" description="Hàng đợi đang trống — quay lại sau." />
          ) : (
            d.queue.map((item) => <QueueRow key={`${item.kind}-${item.id}`} item={item} />)
          )}
        </Panel>

        <div className="ov-side-col">
          <Panel title="5 đối tượng đáng chú ý nhất" kicker="Today's five" bodyClass="ov-spot-list">
            {d.spotlight.length === 0 ? (
              <EmptyState icon="ph ph-user-focus" title="Chưa có đối tượng nổi bật" />
            ) : (
              d.spotlight.map((s, i) => <SpotlightRow key={`${s.person.id}-${i}`} s={s} />)
            )}
          </Panel>
          <Panel title="Chủ đề đang nổi" kicker="Rising signals · 24 giờ" bodyClass="ov-signal-list">
            {d.signals.length === 0 ? (
              <EmptyState icon="ph ph-chart-line-up" title="Chưa có chủ đề nổi bật" />
            ) : (
              (() => {
                const max = Math.max(1, ...d.signals.map((s) => s.count));
                return d.signals.map((s) => (
                  <div className="ov-signal-row" key={s.topic}>
                    <span className="ov-signal-row__topic">{s.topic}</span>
                    <span className="ov-signal-row__bar">
                      <span style={{ width: `${(s.count / max) * 100}%` }} />
                    </span>
                    <span className="ov-signal-row__delta">{s.delta_pct !== null ? `+${fmtDec(s.delta_pct, 0)}%` : '—'}</span>
                  </div>
                ));
              })()
            )}
          </Panel>
        </div>
      </div>

      <div className="ov-bottom-grid">
        <Panel title="Sức khoẻ hệ thống" kicker={`${fmtInt(d.health.plugins.healthy)} khoẻ · ${fmtInt(d.health.plugins.degraded)} suy giảm · ${fmtInt(d.health.plugins.isolated)} cách ly`}>
          <div className="ov-health">
            {d.health.channels.map((c) => (
              <div className="ov-health__row" key={c.type}>
                <span className="ov-health__dot" style={{ background: c.active > 0 ? OK : N5 }} aria-hidden />
                <span className="ov-health__name">Kênh {c.type === 'zalo' ? 'Zalo' : c.type === 'whatsapp' ? 'WhatsApp' : c.type}</span>
                <span className="ov-health__metric">{c.active > 0 ? `${fmtInt(c.active)} đang sống` : 'chưa kết nối'}</span>
              </div>
            ))}
            <div className="ov-health__row">
              <span className="ov-health__dot" style={{ background: d.health.backlog_pending > 0 ? WARN : OK }} aria-hidden />
              <span className="ov-health__name">Backlog sàng lọc</span>
              <span className="ov-health__metric">{fmtInt(d.health.backlog_pending)} bản ghi chờ</span>
            </div>
          </div>
        </Panel>
        <Panel title="Chất lượng dữ liệu" kicker="Hôm nay hệ thống chắc chắn đến đâu">
          <div className="ov-dq">
            <div className="ov-dq__row">
              <span>Hồ sơ còn thiếu danh tính đa kênh</span>
              <b>{fmtPct(d.dataQuality.missing_identity_pct)}</b>
            </div>
            <div className="ov-dq__row">
              <span>Điểm số có độ tin cậy thấp</span>
              <b>{fmtPct(d.dataQuality.low_confidence_score_pct)}</b>
            </div>
            <div className="ov-dq__row">
              <span>Sự kiện chưa gắn được đối tượng</span>
              <b>{fmtPct(d.dataQuality.unassigned_event_pct)}</b>
            </div>
          </div>
        </Panel>
        <Panel title="Nhiệt kế hoạt động" kicker="Hội thoại theo giờ · hôm nay">
          {d.hourly.length === 0 ? <EmptyState icon="ph ph-chart-bar" title="Chưa có sự kiện trong 24 giờ qua" /> : <HourlyChart hourly={d.hourly} />}
        </Panel>
      </div>
    </div>
  );
}
