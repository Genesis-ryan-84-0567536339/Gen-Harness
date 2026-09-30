import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@gen-harness/ui';
import { FOLLOW_UP_KEY } from '../../guide/guideContent';
import { api } from '../../lib/api';

/**
 * v0.1.29 (Boss 30/09): bước 4 "Để sau" được — khi chưa có model nào gán cho Gen/Sàng lọc thì nói thẳng hậu quả và
 * cho một nút sửa ngay. Dùng ở bước 12 của trình thiết lập và đầu Tổng quan.
 */
export function NoModelNotice({ to }: { to: string }) {
  return (
    <div className="risk-box no-model" role="note" data-testid="no-model">
      <Icon name="ph ph-warning-octagon" size={16} color="var(--color-bad)" />
      <div className="no-model__body">
        <div className="risk-box__title">Chưa có model</div>
        <p className="risk-box__text">
          Gen (trợ lý) và sàng lọc tin sẽ không chạy tới khi Sếp chọn model. Tin nhắn vẫn được gom về kho thô.
        </p>
      </div>
      <Link to={to} className="gh-btn gh-btn--primary btn-24">
        <Icon name="ph ph-brain" size={12} />
        Chọn model
      </Link>
    </div>
  );
}

/** Dải đầu Tổng quan — chỉ Owner (API `GET /setup/follow-up` chỉ trả cho Owner; vai trò khác không thấy gì). */
export function NoModelBanner() {
  const q = useQuery({ queryKey: FOLLOW_UP_KEY, queryFn: ({ signal }) => api.setup.followUp(signal) });
  const item = Array.isArray(q.data) ? q.data.find((s) => s.n === 4) : undefined;
  if (!item || item.done) return null;
  return <NoModelNotice to="/guide/4" />;
}
