/**
 * v0.1.59 (G3) — `/owner`: màn TÌNH BÁO (trang chủ Mặt tiền). Thứ tự đọc (điện thoại): tóm tắt bản tin → Việc phải quyết (điểm
 * nhìn đầu: số 28px) → Cảnh báo (ẩn nếu rỗng) → 4 tile 2×2 → Điểm chính → Tin quan trọng → Khách cần chăm. Máy tính: Hàng 1 bản
 * tin · Hàng 2 (4+4+4) ba khối bản tin · Hàng 3 bốn tile · Hàng 4 (8+4) tin quan trọng + khách cần chăm.
 *
 * Mỗi khối tự có 3 trạng thái (khung chờ / OwnerError riêng khối / EmptyState một câu một nút) — một khối lỗi, khối khác vẫn chạy.
 * Ngày đầu (`channels_connected = 0`): thay Hàng 3–4 bằng ĐÚNG MỘT FirstRunCard; giữ Hàng 1, "Việc phải quyết" và "Cảnh báo" nếu có mục.
 * Không có "Chi phí trợ lý Gen" ở trang chủ (chỉ ở Phân tích). Gen chỉ ĐỀ XUẤT — duyệt nháp / xác nhận đề xuất đi qua
 * DraftDecide / ProposalDecide (mã PIN do client tự hỏi).
 *
 * Hàm thuần (safeSection, buildAlertRows…) được export riêng để test; chỉ là hàm hỗ trợ, không ảnh hưởng làm nóng (fast refresh).
 */
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState } from 'react';
import type { InfiniteData, UseInfiniteQueryResult, UseQueryResult } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { FeedItem, InsightKey, InsightMetric, OwnerFeed, OwnerInsights, OwnerRelationRow, OwnerRelations, OwnerToday } from '@gen-harness/contracts';
import { Badge, Card, EmptyState, ListRow, StatTile, useMediaQuery } from '@gen-harness/ui';
import { DEFAULT_TZ, fmtHM, sameDay, fmtDM } from '../../lib/format';
import { useOrgTimezone } from '../../lib/permissions';
import { useDrafts } from '../../screens/core/queries';
import { OWNER_PATHS, asText, countText, moneyText, safeLink } from '../ownerModel';
import { FirstRunCard, OwnerError } from '../parts';
import { useOwnerBrief, useOwnerFeed, useOwnerInsights, useOwnerProposals, useOwnerRelations, useOwnerToday } from '../queries';
import { AlertBlock, BriefHero, DecideBlock, KeyBlock } from './BriefBlocks';
import './intel.css';

/** Sparkline DUY NHẤT của trang chủ: một truy vấn nhẹ (`only=messages_in`), không chạy phần ghép trả lời nặng. */
const SPARK_ONLY: readonly InsightKey[] = ['messages_in'];
const CHANNEL_LABEL: Record<string, string> = { zalo: 'Zalo', whatsapp: 'WhatsApp', telegram: 'Telegram', linkedin: 'LinkedIn' };

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ── Hàng 3: bốn tile ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface TodayVsYesterday {
  today: number;
  /** null = chưa có số hôm qua (chuỗi ngắn hơn 2 điểm). */
  yesterday: number | null;
  spark: number[];
  /** % so với hôm qua; null khi hôm qua = 0 hoặc chưa có. */
  deltaPct: number | null;
}

/** Số tin hôm nay (điểm cuối của chuỗi 7 ngày) so với hôm qua (điểm kề cuối). Chuỗi lạ ⇒ 0, không ném. */
export function todayVsYesterday(metric: Pick<InsightMetric, 'series'> | null | undefined): TodayVsYesterday {
  const series = Array.isArray(metric?.series) ? metric.series : [];
  const values = series.map((p) => num(p?.v));
  const today = values.at(-1) ?? 0;
  const yesterday = values.length >= 2 ? (values.at(-2) ?? 0) : null;
  const deltaPct = yesterday !== null && yesterday > 0 ? Math.round(((today - yesterday) / yesterday) * 1000) / 10 : null;
  return { today, yesterday, spark: values, deltaPct };
}

const CELL = 'kit-m2 kit-tb4 kit-c3';

function MessagesTile({ q }: { q: UseQueryResult<OwnerInsights> }) {
  if (q.isPending) return <Card title="Tin mới hôm nay" state="loading" className={CELL} data-testid="intel-tile-messages-loading" />;
  if (q.isError) {
    return (
      <Card title="Tin mới hôm nay" state="error" className={CELL} data-testid="intel-tile-messages-error">
        <OwnerError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      </Card>
    );
  }
  const metric = (Array.isArray(q.data.metrics) ? q.data.metrics : []).find((m) => m?.key === 'messages_in');
  if (!metric || metric.state === 'error') {
    return <StatTile className={CELL} label="Tin mới hôm nay" value="—" note="Chưa tính được lúc này" data-testid="intel-tile-messages" />;
  }
  const v = todayVsYesterday(metric);
  const hasSeries = v.spark.length > 0;
  return (
    <StatTile
      className={CELL}
      label="Tin mới hôm nay"
      value={v.today}
      delta={v.deltaPct === null ? undefined : { pct: v.deltaPct, good: 'up', compare: 'so với hôm qua' }}
      spark={hasSeries ? v.spark : undefined}
      note={
        v.yesterday === 0
          ? v.today > 0
            ? 'Hôm qua chưa có tin nào'
            : 'Chưa có tin nào trong 2 ngày qua'
          : v.deltaPct === null && v.yesterday === null
            ? 'Chưa có số hôm qua để so sánh'
            : '7 ngày qua'
      }
      data-testid="intel-tile-messages"
    />
  );
}

function KpiTiles({ q }: { q: UseQueryResult<OwnerToday> }) {
  if (q.isPending) {
    return (
      <>
        {['Khách nóng', 'Cơ hội đang mở', 'Lời hứa quá hạn'].map((t) => (
          <Card key={t} title={t} state="loading" className={CELL} data-testid="intel-tile-loading" />
        ))}
      </>
    );
  }
  if (q.isError) {
    return (
      <Card title="Khách nóng, cơ hội, lời hứa" state="error" className="intel-span9" data-testid="intel-tiles-error">
        <OwnerError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      </Card>
    );
  }
  const k = q.data.kpis ?? ({} as Partial<OwnerToday['kpis']>);
  const hot = num(k.hot);
  const opps = num(k.open_opps);
  const late = num(k.overdue_promises);
  return (
    <>
      <StatTile
        className={CELL}
        label="Khách nóng"
        value={hot}
        note={hot > 0 ? 'đang quan tâm mạnh' : 'Chưa có khách nào nóng lên'}
        to={`${OWNER_PATHS.relations}?list=hot`}
        data-testid="intel-tile-hot"
      />
      <StatTile
        className={CELL}
        label="Cơ hội đang mở"
        value={opps}
        note={opps > 0 ? `Tổng giá trị ${moneyText(num(k.open_value_vnd))}` : 'Chưa có cơ hội nào đang mở'}
        to={OWNER_PATHS.analytics}
        data-testid="intel-tile-opps"
      />
      <StatTile
        className={CELL}
        label="Lời hứa quá hạn"
        value={late}
        note={late > 0 ? 'Xem ở Việc' : 'Không có lời hứa nào quá hạn'}
        to={OWNER_PATHS.work}
        data-testid="intel-tile-promises"
      />
    </>
  );
}

// ── Hàng 4: Tin quan trọng nhất · Khách cần chăm ────────────────────────────────────────────────────────────────────

/** Giờ nếu là hôm nay, còn lại ngày/tháng. */
function shortTime(iso: unknown, tz: string): string {
  const s = asText(iso);
  if (!Number.isFinite(Date.parse(s))) return '';
  return sameDay(s, new Date(), tz) ? fmtHM(s, tz) : fmtDM(s, tz);
}

const personName = (p: unknown): string => (p && typeof p === 'object' ? asText((p as { name?: unknown }).name) : '');

/** "Hoàng Thị E · Nhóm Khách sỉ · Zalo" — chuỗi lạ bỏ. */
export function feedWho(it: Pick<FeedItem, 'person' | 'group'>): string {
  const g = it.group && typeof it.group === 'object' ? it.group : null;
  const channel = g ? asText(g.channel) : '';
  return [personName(it.person), g ? asText(g.name) : '', CHANNEL_LABEL[channel] ?? channel].filter(Boolean).join(' · ');
}

function FeedBlock({ q, tz }: { q: UseInfiniteQueryResult<InfiniteData<OwnerFeed, unknown>>; tz: string }) {
  const title = 'Tin quan trọng nhất';
  const all = (
    <Link to={OWNER_PATHS.feed} className="kit-link">
      Xem tất cả
    </Link>
  );
  if (q.isPending) return <Card title={title} state="loading" className="kit-c8" data-testid="intel-feed-loading" />;
  if (q.isError) {
    return (
      <Card title={title} state="error" className="kit-c8" data-testid="intel-feed-error">
        <OwnerError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      </Card>
    );
  }
  const pages = Array.isArray(q.data.pages) ? q.data.pages : [];
  const items = pages.flatMap((p) => (Array.isArray(p?.items) ? p.items : [])).slice(0, 5);
  if (items.length === 0) {
    const filtered = num(pages[0]?.filtered_7d?.filtered);
    return (
      <Card title={title} className="kit-c8" data-testid="intel-feed">
        <EmptyState
          icon="ph ph-chat-text"
          title={filtered > 0 ? `Không có tin cần Sếp để ý. Gen đã lọc ${countText(filtered)} tin.` : 'Không có tin cần Sếp để ý.'}
          action={
            <Link to={OWNER_PATHS.feed} className="kit-btn kit-btn--secondary">
              Xem tất cả
            </Link>
          }
        />
      </Card>
    );
  }
  return (
    <Card title={title} action={all} padded={false} className="kit-c8" data-testid="intel-feed">
      <ul className="kit-list" aria-label="Tin quan trọng nhất">
        {items.map((it) => (
          <ListRow
            key={asText(it.id)}
            as="li"
            to={`${OWNER_PATHS.feed}?tin=${encodeURIComponent(asText(it.id))}`}
            title={
              <span className="intel-feed-title">
                <Badge kind="level" level={asText(it.importance)} />
                <span>{asText(it.title)}</span>
              </span>
            }
            meta={
              <>
                {asText(it.summary) ? <span className="intel-feed-sum">{asText(it.summary)}</span> : null}
                <span>{feedWho(it)}</span>
              </>
            }
            right={shortTime(it.created_at, tz)}
            data-testid="intel-feed-row"
          />
        ))}
      </ul>
    </Card>
  );
}

const REASON: Record<string, { text: string; tone: 'warn' | 'neutral' }> = {
  churn: { text: 'Sắp rời', tone: 'warn' },
  silent: { text: 'Lâu chưa liên lạc', tone: 'neutral' },
};

/** Đường tới hồ sơ trong Quan hệ: `/owner/quan-he?nguoi=<person_id>` (thiếu mã người ⇒ về Quan hệ). */
export function careLink(r: Pick<OwnerRelationRow, 'person_id'>): string {
  const id = asText(r.person_id).trim();
  return id ? `${OWNER_PATHS.relations}?nguoi=${encodeURIComponent(id)}` : OWNER_PATHS.relations;
}

function CareBlock({ q }: { q: UseQueryResult<OwnerRelations> }) {
  const title = 'Khách cần chăm';
  const all = (
    <Link to={OWNER_PATHS.relations} className="kit-link">
      Xem tất cả
    </Link>
  );
  if (q.isPending) return <Card title={title} state="loading" className="kit-c4" data-testid="intel-care-loading" />;
  if (q.isError) {
    return (
      <Card title={title} state="error" className="kit-c4" data-testid="intel-care-error">
        <OwnerError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      </Card>
    );
  }
  const items = (Array.isArray(q.data.items) ? q.data.items : []).slice(0, 3);
  if (items.length === 0) {
    return (
      <Card title={title} className="kit-c4" data-testid="intel-care">
        <EmptyState
          icon="ph ph-users-three"
          title="Không khách nào cần chăm gấp."
          action={
            <Link to={OWNER_PATHS.relations} className="kit-btn kit-btn--secondary">
              Xem Quan hệ
            </Link>
          }
        />
      </Card>
    );
  }
  return (
    <Card title={title} action={all} padded={false} className="kit-c4" data-testid="intel-care">
      <ul className="kit-list" aria-label="Khách cần chăm">
        {items.map((r, i) => {
          const reason = REASON[asText(r.reason)];
          return (
            <ListRow
              key={asText(r.id) || i}
              as="li"
              to={safeLink(careLink(r), OWNER_PATHS.relations)}
              title={
                <span className="intel-care-title">
                  <span>{asText(r.name)}</span>
                  {reason ? (
                    <Badge kind="status" tone={reason.tone}>
                      {reason.text}
                    </Badge>
                  ) : null}
                </span>
              }
              meta={asText(r.metric_text) || asText(r.subtitle) || undefined}
              data-testid="intel-care-row"
            />
          );
        })}
      </ul>
    </Card>
  );
}

// ── màn ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Đã nối kênh nào chưa: lấy từ bản tin, rồi dòng tin, rồi phân tích (cái nào về trước). `undefined` = chưa biết. */
export function channelsConnected(...sources: unknown[]): number | undefined {
  for (const s of sources) if (typeof s === 'number' && Number.isFinite(s)) return s;
  return undefined;
}

export function IntelScreen(): JSX.Element {
  useEffect(() => {
    document.title = 'Tình báo · Gen-Harness';
  }, []);
  const tz = useOrgTimezone() || DEFAULT_TZ;
  const wide = useMediaQuery('(min-width: 760px)');
  // Bản tin đang xem: bỏ trống = mới nhất. Các khối số liệu luôn dùng bản mới nhất (live + cảnh báo không đổi theo bản cũ).
  const [briefId, setBriefId] = useState<string | undefined>(undefined);
  const latest = useOwnerBrief();
  const picked = useOwnerBrief(briefId);
  const today = useOwnerToday();
  const drafts = useDrafts('pending');
  const proposals = useOwnerProposals();
  const insights = useOwnerInsights('week', SPARK_ONLY);
  const feed = useOwnerFeed('important', 5);
  const care = useOwnerRelations('care', 3);

  const channels = channelsConnected(latest.data?.channels_connected, feed.data?.pages?.[0]?.channels_connected, insights.data?.channels_connected);
  const firstRun = channels === 0;

  const decide = <DecideBlock drafts={drafts} proposals={proposals} today={today} brief={latest} hideWhenEmpty={firstRun} cell="kit-tb4 kit-c4" />;
  const alerts = <AlertBlock brief={latest} hideWhenEmpty={firstRun} cell="kit-tb4 kit-c4" />;
  const key = <KeyBlock brief={latest} cell="kit-c4" />;

  return (
    <div className="owner-screen intel" data-testid="owner-frame-intel">
      <BriefHero brief={picked} selectedId={briefId} onSelect={setBriefId} tz={tz} />
      <div className="kit-grid" data-testid="intel-grid">
        {decide}
        {alerts}
        {firstRun ? (
          <div className="kit-c12">
            <FirstRunCard />
          </div>
        ) : (
          <>
            {wide ? key : null}
            <MessagesTile q={insights} />
            <KpiTiles q={today} />
            {wide ? null : key}
            <FeedBlock q={feed} tz={tz} />
            <CareBlock q={care} />
          </>
        )}
      </div>
    </div>
  );
}
