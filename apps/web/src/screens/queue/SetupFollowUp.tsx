import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@gen-harness/ui';
import { api } from '../../lib/api';
import { qk } from '../../lib/queries';
import { Panel } from '../common';

/**
 * "Việc thiết lập tiếp": các bước Owner chọn "Để sau" ở trình thiết lập (5–11) không biến mất mà hiện ở đây,
 * mỗi mục dẫn thẳng tới màn Console làm tiếp được. "Đã xong" chỉ ẩn mục trên trình duyệt này.
 */
const FOLLOW_UP: Record<number, { hint: string; to: string }> = {
  5: { hint: 'Quét QR Zalo/WhatsApp để agent nghe được tin nhắn.', to: '/system?tab=channels' },
  6: { hint: 'Bật từng nhóm cần nghe và chọn chế độ nghe.', to: '/directory' },
  7: { hint: 'Chọn quy tắc sàng lọc và chu kỳ đưa dữ liệu vào kho sạch.', to: '/rules' },
  8: { hint: 'Tạo agent đầu tiên từ mẫu có sẵn và gán kênh.', to: '/agents' },
  9: { hint: 'Đặt mức tự trị và ngưỡng tiền phải duyệt.', to: '/agents' },
  10: { hint: 'Mời người trong đội và gán vai trò.', to: '/system?tab=roles' },
  11: { hint: 'Đặt lịch sao lưu tự động.', to: '/system?tab=storage' },
};

const DISMISS_KEY = 'gh.setupFollowUp.dismissed';

function loadDismissed(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

export function SetupFollowUp() {
  const state = useQuery({ queryKey: qk.setupState, queryFn: ({ signal }) => api.setup.state(signal) });
  const [dismissed, setDismissed] = useState<number[]>(loadDismissed);
  if (!state.data) return null;
  const items = state.data.steps.filter((s) => s.status === 'skipped' && FOLLOW_UP[s.n] && !dismissed.includes(s.n));
  if (items.length === 0) return null;

  const dismiss = (n: number) => {
    const next = [...dismissed, n];
    setDismissed(next);
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {
      /* trình duyệt chặn lưu — mục chỉ ẩn trong phiên này */
    }
  };

  return (
    <Panel
      title="Việc thiết lập tiếp"
      kicker={`${items.length} bước Sếp đã để sau ở trình thiết lập — làm khi sẵn sàng`}
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
            <button type="button" className="gh-btn gh-btn--ghost btn-24" onClick={() => dismiss(s.n)}>
              Đã xong
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
