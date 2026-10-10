/**
 * v0.1.55 (G5) — `/owner/quan-he`: màn Quan hệ. Bốn danh sách (Khách nóng, Quan hệ nguội, Cầu nối, Cung ↔ Cầu) lấy từ
 * `GET /owner/relations?list=…`; bấm một dòng mở Hồ sơ sống (`/profile?id=…`). Danh sách chọn bằng `?list=` trên địa chỉ nên
 * 4 số ở Hôm nay mở thẳng đúng danh sách. Chữ đời thường — không có thuật ngữ kỹ thuật.
 */
import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Panel } from '../screens/common';
import { RELATION_TABS, asText, isRelationList, relationTab, type OwnerRelationList } from './ownerModel';
import { Avatar, ListSkeleton, OwnerEmpty, OwnerError, RowLink } from './parts';
import { useOwnerRelations } from './queries';

export function RelationsScreen() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const raw = params.get('list');
  const list: OwnerRelationList = isRelationList(raw) ? raw : 'hot';
  const tab = relationTab(list);
  const q = useOwnerRelations(list);
  useEffect(() => {
    document.title = 'Quan hệ · Gen-Harness';
  }, []);

  const pick = (next: OwnerRelationList) => navigate({ pathname: '/owner/quan-he', search: next === 'hot' ? '' : `?list=${next}` }, { replace: true });
  const items = Array.isArray(q.data?.items) ? q.data.items : [];

  return (
    <div className="owner-screen" data-testid="owner-relations">
      <div className="owner-tabs" role="tablist" aria-label="Danh sách quan hệ">
        {RELATION_TABS.map((t) => (
          <button
            key={t.list}
            type="button"
            role="tab"
            id={`owner-rel-tab-${t.list}`}
            aria-selected={t.list === list}
            aria-controls="owner-rel-panel"
            className="owner-tab"
            data-testid={`owner-rel-tab-${t.list}`}
            onClick={() => pick(t.list)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Panel title={tab.label} kicker={tab.hint} flush>
        <div id="owner-rel-panel" role="tabpanel" aria-labelledby={`owner-rel-tab-${list}`} data-testid="owner-rel-panel" data-list={list}>
          {q.isPending ? (
            <ListSkeleton rows={5} label="Đang tải danh sách" />
          ) : q.isError ? (
            <OwnerError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
          ) : items.length === 0 ? (
            <OwnerEmpty icon="ph ph-users-three" title={tab.emptyTitle} hint={tab.emptyHint} />
          ) : (
            <div className="owner-list">
              {items.map((r) => (
                <RowLink
                  key={asText(r.id)}
                  to={r.to}
                  title={r.name}
                  meta={r.subtitle}
                  right={r.metric_text}
                  lead={<Avatar name={r.name} />}
                  testId="owner-rel-row"
                />
              ))}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
