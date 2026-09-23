import { useEffect } from 'react';
import { SCREEN_BY_KEY } from '@gen-harness/contracts';
import { Card, EmptyState, ErrorState, Skeleton } from '@gen-harness/ui';
import { useNavigation } from '../lib/queries';
import { screenKeys } from '../shell/navModel';

/** Screen-title row: title 20px/500 + description 12.5px neutral-400 (docs/01 "Quy ước chung"). */
export function ScreenTitle({ title, description, maxWidth }: { title: string; description: string; maxWidth: number }) {
  return (
    <div className="screen-title-row">
      <div className="screen-title-block" style={{ maxWidth }}>
        <h2 className="screen-title">{title}</h2>
        <p className="screen-desc">{description}</p>
      </div>
    </div>
  );
}

/**
 * Phase 1: every screen shows its title row and a placeholder card — no fake
 * data. A screen the role cannot see (absent from GET /navigation) says so.
 */
export function ScreenPage({ screenKey }: { screenKey: string }) {
  const meta = SCREEN_BY_KEY[screenKey];
  const nav = useNavigation();

  useEffect(() => {
    document.title = `${meta.title} · Gen-Harness`;
  }, [meta.title]);

  // Thiết kế không vẽ dòng tiêu đề cho overview, workbench, profile (header đã mang tiêu đề) → giữ nguyên như vậy.
  const title = meta.designTitleRow ? (
    <ScreenTitle title={meta.title} description={meta.description} maxWidth={meta.descMaxWidth} />
  ) : null;

  if (nav.isPending) {
    return (
      <div className="screen" aria-busy="true">
        {meta.designTitleRow && <div className="screen-title-row">
          <div className="screen-title-block" style={{ maxWidth: meta.descMaxWidth }}>
            <Skeleton width={220} height={20} />
            <Skeleton width="80%" height={12} style={{ marginTop: 9 }} />
            <Skeleton width="55%" height={12} style={{ marginTop: 6 }} />
          </div>
        </div>}
        <Card padded={false}>
          <div className="gh-state">
            <Skeleton width={34} height={34} radius={8} />
            <div style={{ flex: 1 }}>
              <Skeleton width={260} height={12} />
              <Skeleton width={380} height={10} style={{ marginTop: 8 }} />
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (nav.isError) {
    return (
      <div className="screen">
        {title}
        <Card padded={false}>
          <ErrorState message={nav.error.message} onRetry={() => void nav.refetch()} retrying={nav.isFetching} />
        </Card>
      </div>
    );
  }

  const allowed = screenKeys(nav.data).has(screenKey);
  return (
    <div className="screen">
      {title}
      <Card padded={false} aria-label={meta.name}>
        {allowed ? (
          <EmptyState
            icon="ph ph-hourglass-medium"
            title="Màn hình này được dựng ở giai đoạn sau"
            description="Khung, danh mục và quyền truy cập đã sẵn sàng. Dữ liệu thật sẽ hiện ở đây khi API của màn này hoàn tất."
          />
        ) : (
          <EmptyState
            icon="ph ph-lock-simple"
            title="Vai trò của bạn không có quyền xem màn này"
            description="Danh mục chỉ hiện những màn được cấp. Liên hệ Owner nếu cần mở quyền."
          />
        )}
      </Card>
    </div>
  );
}

export function NotFoundScreen() {
  useEffect(() => {
    document.title = 'Không tìm thấy · Gen-Harness';
  }, []);
  return (
    <div className="screen">
      <Card padded={false}>
        <EmptyState icon="ph ph-warning-circle" title="Không tìm thấy màn hình" description="Đường dẫn này không thuộc Console. Chọn một màn ở thanh bên." />
      </Card>
    </div>
  );
}
