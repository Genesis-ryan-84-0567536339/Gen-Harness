import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, Icon } from '@gen-harness/ui';
import { useHeaderStatus, useMe } from '../lib/queries';

export type DataEmptyReason = 'no-channel' | 'no-group';

/** Vì sao danh sách trống: chưa nối kênh nào, hoặc đã nối nhưng chưa nghe nhóm nào; `null` khi đã có nguồn dữ liệu. */
// Hàm thuần đi cùng component (test gọi trực tiếp) — chấp nhận mất fast refresh cho tệp nhỏ này.
// eslint-disable-next-line react-refresh/only-export-components
export function dataEmptyReason(h?: { channels_live: number; groups_listening: number } | null): DataEmptyReason | null {
  if (!h) return null;
  if (!(h.channels_live > 0)) return 'no-channel';
  if (!(h.groups_listening > 0)) return 'no-group';
  return null;
}

/**
 * v0.1.43 (F-29) — danh sách trống vì CHƯA CÓ NGUỒN dữ liệu thì nói rõ lý do và dẫn đường (Owner: nút tới bước hướng
 * dẫn; vai trò khác: nhờ Owner). Đọc cùng truy vấn với header (`useHeaderStatus`) nên không thêm request. Header đang
 * tải/lỗi hoặc đã có kênh + nhóm → hiện `fallback` (trạng thái trống cũ của màn, vd "không khớp bộ lọc").
 */
export function DataEmptyState({ fallback }: { fallback: ReactNode }) {
  const header = useHeaderStatus();
  const me = useMe();
  const reason = header.isSuccess ? dataEmptyReason(header.data) : null;
  if (!reason) return <>{fallback}</>;
  const isOwner = me.data?.role?.code === 'owner';

  const view =
    reason === 'no-channel'
      ? {
          icon: 'ph ph-plugs',
          title: 'Chưa có dữ liệu vì chưa nối kênh',
          ownerText: 'Nối Zalo để tin nhắn bắt đầu về đây.',
          otherText: 'Nhờ Owner nối Zalo ở Kết nối — tin nhắn sẽ hiện ở đây sau đó.',
          to: '/guide/5',
          cta: 'Nối Zalo',
          ctaIcon: 'ph ph-plugs-connected',
        }
      : {
          icon: 'ph ph-users-three',
          title: 'Chưa chọn nhóm nào để nghe',
          ownerText: 'Kênh đã nối nhưng chưa bật nghe nhóm nào. Chọn nhóm để hệ thống bắt đầu đọc tin.',
          otherText: 'Nhờ Owner chọn nhóm để nghe ở Kết nối.',
          to: '/guide/6',
          cta: 'Chọn nhóm để nghe',
          ctaIcon: 'ph ph-ear',
        };

  return (
    <div data-testid="data-empty-state" data-reason={reason}>
      <EmptyState
        icon={view.icon}
        title={view.title}
        description={isOwner ? view.ownerText : view.otherText}
        actions={
          isOwner ? (
            <Link to={view.to} className="gh-btn gh-btn--primary btn-24">
              <Icon name={view.ctaIcon} size={12} />
              {view.cta}
            </Link>
          ) : undefined
        }
      />
    </div>
  );
}
