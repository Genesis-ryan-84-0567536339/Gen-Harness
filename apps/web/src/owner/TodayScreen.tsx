/**
 * v0.1.55 (G5) — `/owner`: màn Hôm nay của Mặt tiền. Từ trên xuống: thẻ "Hôm nay của Sếp" (Gen hướng dẫn, dùng lại nguyên
 * `CoachTodayCard`), "Cần Sếp duyệt", 4 số, Bản tin Gen mới nhất, câu "Tuần này Gen lọc giúp Sếp…", thẻ gợi ý và tiến độ
 * "Việc Sếp cần làm". Chỉ ĐỌC: mọi dòng là link sâu tới luồng đã có (duyệt nháp, đề xuất Gen + mã PIN, Bộ não AI).
 * Chữ đời thường — không có thuật ngữ kỹ thuật ở màn này.
 */
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Icon, Skeleton } from '@gen-harness/ui';
import { CoachTodayCard } from '../gen/CoachTodayCard';
import { fmtAgo } from '../lib/format';
import { Panel } from '../screens/common';
import {
  asText,
  filterValueText,
  kpiCards,
  progressText,
  reviewLabel,
  safeLink,
  REVIEW_ICON,
  REVIEW_TONE,
  type OwnerBriefing,
  type OwnerSuggestion,
  type OwnerToday,
} from './ownerModel';
import { IconTile, ListSkeleton, OwnerEmpty, OwnerError, RowLink } from './parts';
import { useOwnerToday } from './queries';

export function TodayScreen() {
  const q = useOwnerToday();
  useEffect(() => {
    document.title = 'Hôm nay · Gen-Harness';
  }, []);

  return (
    <div className="owner-screen" data-testid="owner-today">
      {/* Thẻ của Gen hướng dẫn tự ẩn khi không phải Owner / Gen tắt / máy chủ chưa có. */}
      <CoachTodayCard />
      {q.isPending ? (
        <TodaySkeleton />
      ) : q.isError ? (
        <Panel title="Hôm nay">
          <OwnerError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        </Panel>
      ) : (
        <TodayBody d={q.data} />
      )}
    </div>
  );
}

function TodaySkeleton() {
  return (
    <>
      <Panel title="Cần Sếp duyệt" flush>
        <ListSkeleton rows={3} label="Đang tải việc cần duyệt" />
      </Panel>
      <div className="owner-kpis" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <div className="owner-kpi" key={i}>
            <Skeleton width={80} height={10} />
            <Skeleton width={46} height={24} style={{ marginTop: 8 }} />
          </div>
        ))}
      </div>
    </>
  );
}

function TodayBody({ d }: { d: OwnerToday }) {
  const review = Array.isArray(d.needs_review) ? d.needs_review : [];
  const cards = kpiCards(d.kpis);
  const value = filterValueText(d.filter_value);
  const suggestions = Array.isArray(d.suggestions) ? d.suggestions : [];
  return (
    <>
      <Panel
        title="Cần Sếp duyệt"
        kicker="Bản nháp, đề xuất của Gen và việc quá hạn — bấm để xử lý ở đúng chỗ"
        aside={review.length > 0 ? <span className="owner-count" data-testid="owner-review-count">{review.length}</span> : undefined}
        flush
      >
        {review.length === 0 ? (
          <OwnerEmpty icon="ph ph-check-circle" title="Chưa có gì chờ Sếp duyệt" hint="Có bản nháp hay việc quá hạn, em sẽ báo ngay ở đây." />
        ) : (
          <div className="owner-list" data-testid="owner-review">
            {review.map((it, i) => (
              <RowLink
                key={`${asText(it.kind)}-${i}`}
                to={it.to}
                title={it.title}
                meta={`${reviewLabel(it.kind)}${it.at ? ` · ${fmtAgo(it.at)}` : ''}`}
                lead={<IconTile icon={REVIEW_ICON[it.kind] ?? 'ph ph-bell'} tone={REVIEW_TONE[it.kind]} />}
                testId="owner-review-row"
              />
            ))}
          </div>
        )}
      </Panel>

      <section className="owner-kpis" aria-label="Bốn số chính" data-testid="owner-kpis">
        {cards.map((k) => (
          <Link key={k.key} to={safeLink(k.to)} className="owner-kpi" data-tone={k.tone} data-testid={`owner-kpi-${k.key}`}>
            <span className="owner-kpi__head">
              <Icon name={k.icon} size={14} />
              <span className="owner-kpi__label">{k.label}</span>
            </span>
            <span className="owner-kpi__value">{k.value}</span>
            {k.sub ? <span className="owner-kpi__sub">{k.sub}</span> : null}
          </Link>
        ))}
      </section>

      {d.briefing_latest ? <BriefingCard b={d.briefing_latest} /> : null}

      {value ? (
        <section className="owner-value" data-testid="owner-filter-value">
          <IconTile icon="ph ph-funnel" tone="ok" />
          <p>{value}</p>
        </section>
      ) : null}

      {suggestions.length > 0 ? (
        <section className="owner-suggest" aria-label="Gợi ý của Gen" data-testid="owner-suggestions">
          {suggestions.map((s) => (
            <SuggestionCard key={asText(s.key)} s={s} />
          ))}
        </section>
      ) : null}

      <Link to="/guide/viec-sep" className="owner-progress" data-testid="owner-progress">
        <Icon name="ph ph-list-checks" size={14} />
        <span>{progressText(d.progress?.required_done, d.progress?.required_total)}</span>
        <Icon className="owner-row__go" name="ph ph-caret-right" size={12} />
      </Link>
    </>
  );
}

function BriefingCard({ b }: { b: OwnerBriefing }) {
  const summary = asText(b.summary_text);
  return (
    <Panel title="Bản tin mới nhất" kicker={`${asText(b.title)}${b.at ? ` · ${fmtAgo(b.at)}` : ''}`}>
      <div className="owner-brief" data-testid="owner-briefing">
        {summary ? <p className="owner-brief__text">{summary}</p> : <p className="owner-brief__text owner-muted">Bản tin chưa có lời tóm tắt.</p>}
        <Link to={safeLink(b.to)} className="gh-btn gh-btn--secondary btn-24">
          <Icon name="ph ph-file-text" size={13} /> Mở bản tin
        </Link>
      </div>
    </Panel>
  );
}

function SuggestionCard({ s }: { s: OwnerSuggestion }) {
  return (
    <div className="owner-suggest__card" data-testid={`owner-suggest-${asText(s.key)}`}>
      <IconTile icon="ph ph-lightbulb" tone="accent" />
      <div className="owner-suggest__text">
        <div className="owner-suggest__title">{asText(s.title)}</div>
        <p className="owner-suggest__body">{asText(s.body)}</p>
      </div>
      <Link to={safeLink(s.to)} className="gh-btn gh-btn--secondary btn-24">
        Mở
      </Link>
    </div>
  );
}
