import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@gen-harness/ui';
import { FOLLOW_UP_KEY, GUIDE_BY_N, followUpHidden, guideOrdinal } from '../../guide/guideContent';
import { api } from '../../lib/api';
import { useMe } from '../../lib/queries';
import { useUiStore } from '../../lib/uiStore';
import { Panel } from '../common';


/**
 * "Việc thiết lập tiếp": các việc tuỳ chọn 5–11 (+ 13 Facebook, 14 Gen-hub từ v0.1.39) chưa xong. Mỗi mục mở thẳng
 * form/màn làm việc đó (`/guide/:n` hoặc `doTo`), đầu thẻ dẫn tới trang Hướng dẫn thiết lập. Xong hay chưa do API suy từ dữ liệu thật (`GET /setup/follow-up`)
 * — làm xong ở form hướng dẫn hay ở màn Console thì mục cũng tự biến mất, không cần bấm tay.
 */
export function SetupFollowUp() {
  const me = useMe();
  const isOwner = me.data?.role?.code === 'owner';
  // Chỉ Owner (API /setup/* trả 403 cho vai trò khác) — không gọi thừa.
  const q = useQuery({ queryKey: FOLLOW_UP_KEY, queryFn: ({ signal }) => api.setup.followUp(signal), enabled: isOwner });
  const userId = me.data?.id ?? '';
  const hidden = useUiStore((s) => s.followUpHiddenByUser[userId]);
  const hide = useUiStore((s) => s.hideFollowUp);
  // Bước 4 (chưa có model) có dải cảnh báo riêng ở đầu Tổng quan — không lặp ở đây.
  const items = (q.data ?? []).filter((s) => !s.done && s.n !== 4 && GUIDE_BY_N[s.n]);
  if (!isOwner || items.length === 0 || followUpHidden(items.map((s) => s.n), hidden)) return null;

  return (
    <Panel
      title="Việc thiết lập tiếp"
      kicker={`${items.length} việc thiết lập còn lại — làm khi sẵn sàng, xong sẽ tự biến mất`}
      label="Việc thiết lập tiếp"
      bodyClass="ov-followup"
      aside={
        <span className="ov-followup__aside">
          <Link to="/guide" className="gh-btn gh-btn--primary btn-24">
            <Icon name="ph ph-list-checks" size={12} />
            Hướng dẫn thiết lập
          </Link>
          <button
            type="button"
            className="gh-btn gh-btn--ghost btn-24"
            title="Ẩn thẻ này với riêng Sếp — vẫn mở được Hướng dẫn thiết lập ở menu tài khoản hoặc thanh bên"
            onClick={() => userId && hide(userId, items.map((s) => s.n))}
          >
            Ẩn
          </button>
        </span>
      }
    >
      <ul className="ov-followup__list">
        {items.map((s) => (
          <li key={s.n} className="ov-followup__item">
            <span className="ov-followup__num mono">{guideOrdinal(s.n)}</span>
            <div className="ov-followup__body">
              <div className="ov-followup__title">{GUIDE_BY_N[s.n].title}</div>
              <div className="ov-followup__hint">{GUIDE_BY_N[s.n].why}</div>
            </div>
            <Link to={GUIDE_BY_N[s.n].doTo ?? `/guide/${s.n}`} className="gh-btn gh-btn--secondary btn-24">
              Làm ngay
              <Icon name="ph ph-arrow-right" size={12} />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
