import { useEffect } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Card, EmptyState, ErrorState, Skeleton } from '@gen-harness/ui';
import { errorDetail, errorText } from '../lib/errorText';
import { useNavigation } from '../lib/queries';
import { firstScreenKey } from './navModel';

/**
 * v0.1.42 (F-26): trang chủ "/" chuyển tới màn đầu tiên KHÔNG ẩn trong danh mục của vai trò (GET /navigation) —
 * không còn cứng "/overview" (Agent NV không có quyền Tổng quan từng gặp ổ khoá ngay khi đăng nhập). Giữ nguyên
 * query (vd `?gen=` mở Bản tin Gen từ chuông).
 */
export function HomeRedirect() {
  const nav = useNavigation();
  const { search } = useLocation();

  useEffect(() => {
    document.title = 'Gen-Harness';
  }, []);

  if (nav.isPending) {
    return (
      <div className="screen" aria-busy="true" aria-label="Đang mở trang chủ">
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
        <Card padded={false}>
          <ErrorState
            title="Không tải được danh mục"
            message={errorText(nav.error)}
            detail={errorDetail(nav.error) ?? 'GET /navigation thất bại'}
            onRetry={() => void nav.refetch()}
            retrying={nav.isFetching}
          />
        </Card>
      </div>
    );
  }

  const key = firstScreenKey(nav.data);
  if (!key) {
    return (
      <div className="screen">
        <Card padded={false}>
          <EmptyState
            icon="ph ph-user-circle"
            title="Vai trò này chưa được cấp màn hình nào"
            description="Nhờ Owner cấp thêm quyền ở Đội ngũ. Thông tin tài khoản của bạn vẫn xem được."
            actions={<Link to="/account">Tài khoản của tôi</Link>}
          />
        </Card>
      </div>
    );
  }
  return <Navigate to={`/${key}${search}`} replace />;
}
