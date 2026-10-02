import { Link } from 'react-router-dom';
import { Icon } from '@gen-harness/ui';
import { useMe } from '../../lib/queries';
import { Panel } from '../common';

/**
 * v0.1.39 (F-32): thẻ Facebook ở Hệ thống › Kênh — lối vào trang Tài khoản mạng xã hội (/social), nơi Sếp đăng
 * nhập Facebook ngay trong app để Gen đọc thông báo và tin nhắn. Chỉ Owner (trang /social chỉ cho Owner) — target Gen
 * `system.channels.facebook` khai `permission: 'roles.manage'` (quyền chỉ Owner có, như các target Owner khác) để Gen
 * không chỉ một Admin tới thẻ không hiện trên màn hình của họ.
 */
export function SocialEntryCard() {
  const me = useMe();
  if (me.data?.role?.code !== 'owner') return null;
  return (
    <Panel
      genTarget="system.channels.facebook"
      title="Facebook"
      kicker="Đọc thông báo và tin nhắn — đăng nhập ngay trong app"
      label="Facebook"
      bodyClass="pin-body"
    >
      <div className="pin-actions">
        <Link to="/social" className="gh-btn gh-btn--secondary">
          <Icon name="ph ph-facebook-logo" size={14} />
          Mở trang Tài khoản mạng xã hội
        </Link>
      </div>
    </Panel>
  );
}
