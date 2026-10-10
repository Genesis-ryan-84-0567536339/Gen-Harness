/**
 * v0.1.55 (G5) — `/owner/viec`: màn Việc. Ba nhóm từ `GET /owner/tasks`: Hộp thư đã lọc, Bàn làm việc, Việc & Nhắc hẹn.
 * Chỉ ĐẾM + vài dòng mẫu + link sâu tới màn đầy đủ của Console (xử lý ở đó), không làm gì tại chỗ.
 */
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@gen-harness/ui';
import { fmtAgo } from '../lib/format';
import { Panel } from '../screens/common';
import { TASK_GROUP_EMPTY, TASK_GROUP_ICON, asText, countText, safeLink, type OwnerTaskGroup } from './ownerModel';
import { IconTile, ListSkeleton, OwnerEmpty, OwnerError, RowLink } from './parts';
import { useOwnerTasks } from './queries';

export function OwnerTasksScreen() {
  const q = useOwnerTasks();
  useEffect(() => {
    document.title = 'Việc · Gen-Harness';
  }, []);
  const groups = Array.isArray(q.data?.groups) ? q.data.groups : [];

  return (
    <div className="owner-screen" data-testid="owner-tasks">
      {q.isPending ? (
        <Panel title="Việc" flush>
          <ListSkeleton rows={6} label="Đang tải việc" />
        </Panel>
      ) : q.isError ? (
        <Panel title="Việc" flush>
          <OwnerError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        </Panel>
      ) : allEmpty(groups) ? (
        <Panel title="Việc" flush>
          <OwnerEmpty icon="ph ph-check-square" title="Chưa có việc nào" hint="Có tin mới, bản nháp hay việc đến hạn, em sẽ gom lại ở đây." />
        </Panel>
      ) : (
        groups.map((g) => <Group key={asText(g.key)} g={g} />)
      )}
    </div>
  );
}

/** Máy chủ không trả nhóm nào, hoặc cả ba nhóm đều 0 và không có dòng mẫu ⇒ một trạng thái rỗng chung (thay vì ba hộp rỗng). */
function allEmpty(groups: OwnerTaskGroup[]): boolean {
  return groups.every((g) => !(g.count > 0) && !(Array.isArray(g.items) && g.items.length > 0));
}

function Group({ g }: { g: OwnerTaskGroup }) {
  const items = Array.isArray(g.items) ? g.items : [];
  return (
    <Panel
      title={asText(g.title)}
      kicker={g.count > 0 ? `${countText(g.count)} mục` : 'Không có gì chờ'}
      aside={<span className="owner-count" data-testid={`owner-group-count-${asText(g.key)}`}>{countText(g.count)}</span>}
      flush
    >
      <div data-testid={`owner-group-${asText(g.key)}`}>
        {items.length === 0 ? (
          <OwnerEmpty icon={TASK_GROUP_ICON[g.key] ?? 'ph ph-tray'} title={TASK_GROUP_EMPTY[g.key] ?? 'Chưa có gì.'} />
        ) : (
          <div className="owner-list">
            {items.map((it, i) => (
              <RowLink
                key={i}
                to={it.to}
                title={it.title}
                meta={it.at ? fmtAgo(it.at) : ''}
                lead={<IconTile icon={TASK_GROUP_ICON[g.key] ?? 'ph ph-tray'} />}
                testId="owner-task-row"
              />
            ))}
          </div>
        )}
        <Link to={safeLink(g.to)} className="owner-more" data-testid={`owner-group-open-${asText(g.key)}`}>
          Xem tất cả
          <Icon name="ph ph-arrow-right" size={13} />
        </Link>
      </div>
    </Panel>
  );
}
