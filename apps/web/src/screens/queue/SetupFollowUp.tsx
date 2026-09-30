import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@gen-harness/ui';
import { FOLLOW_UP_KEY, GUIDE_BY_N } from '../../guide/guideContent';
import { api } from '../../lib/api';
import { Panel } from '../common';

/**
 * "Việc thiết lập tiếp": các việc tuỳ chọn 5–11 chưa xong. Mỗi mục mở thẳng form làm việc đó (`/guide/:n`), đầu
 * thẻ dẫn tới trang Hướng dẫn kết nối từng bước. Xong hay chưa do API suy từ dữ liệu thật (`GET /setup/follow-up`)
 * — làm xong ở form hướng dẫn hay ở màn Console thì mục cũng tự biến mất, không cần bấm tay.
 */
export function SetupFollowUp() {
  const q = useQuery({ queryKey: FOLLOW_UP_KEY, queryFn: ({ signal }) => api.setup.followUp(signal) });
  // Bước 4 (chưa có model) có dải cảnh báo riêng ở đầu Tổng quan — không lặp ở đây.
  const items = (q.data ?? []).filter((s) => !s.done && s.n !== 4 && GUIDE_BY_N[s.n]);
  if (items.length === 0) return null;

  return (
    <Panel
      title="Việc thiết lập tiếp"
      kicker={`${items.length} việc Sếp đã để sau — làm khi sẵn sàng, xong sẽ tự biến mất`}
      label="Việc thiết lập tiếp"
      bodyClass="ov-followup"
      aside={
        <Link to="/guide" className="gh-btn gh-btn--primary btn-24">
          <Icon name="ph ph-list-checks" size={12} />
          Hướng dẫn từng bước
        </Link>
      }
    >
      <ul className="ov-followup__list">
        {items.map((s) => (
          <li key={s.n} className="ov-followup__item">
            <span className="ov-followup__num mono">{String(s.n).padStart(2, '0')}</span>
            <div className="ov-followup__body">
              <div className="ov-followup__title">{GUIDE_BY_N[s.n].title}</div>
              <div className="ov-followup__hint">{GUIDE_BY_N[s.n].why}</div>
            </div>
            <Link to={`/guide/${s.n}`} className="gh-btn gh-btn--secondary btn-24">
              Làm ngay
              <Icon name="ph ph-arrow-right" size={12} />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
