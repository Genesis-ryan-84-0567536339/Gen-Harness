import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@gen-harness/ui';
import { api } from '../../lib/api';
import { Panel } from '../common';

/**
 * "Việc thiết lập tiếp": các bước Owner chọn "Để sau" ở trình thiết lập (5–11) hiện ở đây, mỗi mục dẫn thẳng tới
 * màn Console làm tiếp được. Xong hay chưa do API suy từ dữ liệu thật (`GET /setup/follow-up`) — làm xong ở
 * Console thì mục tự biến mất, không cần bấm tay.
 */
const FOLLOW_UP: Record<number, { hint: string; to: string }> = {
  5: { hint: 'Quét QR Zalo/WhatsApp để agent nghe được tin nhắn.', to: '/system?tab=channels' },
  6: { hint: 'Bật từng nhóm cần nghe và chọn chế độ nghe.', to: '/directory' },
  7: { hint: 'Bật quy tắc sàng lọc để dữ liệu vào kho sạch.', to: '/rules' },
  8: { hint: 'Tạo agent đầu tiên từ mẫu có sẵn và gán kênh.', to: '/agents' },
  9: { hint: 'Đặt mức tự trị cho agent (trong form agent).', to: '/agents' },
  10: { hint: 'Mời người trong đội và gán vai trò.', to: '/system?tab=roles' },
  11: { hint: 'Đặt lịch sao lưu tự động.', to: '/system?tab=storage' },
};

export function SetupFollowUp() {
  const q = useQuery({ queryKey: ['setup', 'follow-up'], queryFn: ({ signal }) => api.setup.followUp(signal) });
  const items = (q.data ?? []).filter((s) => !s.done && FOLLOW_UP[s.n]);
  if (items.length === 0) return null;

  return (
    <Panel
      title="Việc thiết lập tiếp"
      kicker={`${items.length} việc Sếp đã để sau — làm khi sẵn sàng, xong sẽ tự biến mất`}
      label="Việc thiết lập tiếp"
      bodyClass="ov-followup"
    >
      <ul className="ov-followup__list">
        {items.map((s) => (
          <li key={s.n} className="ov-followup__item">
            <span className="ov-followup__num mono">{String(s.n).padStart(2, '0')}</span>
            <div className="ov-followup__body">
              <div className="ov-followup__title">{s.title}</div>
              <div className="ov-followup__hint">{FOLLOW_UP[s.n].hint}</div>
            </div>
            <Link to={FOLLOW_UP[s.n].to} className="gh-btn gh-btn--secondary btn-24">
              Làm ngay
              <Icon name="ph ph-arrow-right" size={12} />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
