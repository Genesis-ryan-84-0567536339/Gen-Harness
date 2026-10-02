import { Link } from 'react-router-dom';
import { SCREEN_BY_KEY } from '@gen-harness/contracts';
import { Icon } from '@gen-harness/ui';
import { useNavigation } from '../../lib/queries';
import { findActive } from '../../shell/navModel';
import { ScreenHead } from '../common';
import { UsersTab } from '../system/UsersTab';

const STAFF_LINKS = [
  { key: 'people', to: '/people', icon: 'ph ph-users-three', label: 'Đánh giá con người', hint: 'Điểm số có chứng cứ, xu hướng theo tuần' },
  { key: 'care', to: '/care', icon: 'ph ph-heartbeat', label: 'Chất lượng chăm sóc', hint: 'Cách chăm khách, không chỉ số lần nhắn' },
];

/**
 * v0.1.42 (F-7): Đội ngũ — người dùng Console (mời, đổi vai trò, khoá; trước ở Điều khiển hệ thống › Người dùng) và
 * lối vào Đánh giá con người / Chất lượng chăm sóc khi API cho hiện (đã có ít nhất 1 nhân viên).
 */
export function TeamScreen() {
  const meta = SCREEN_BY_KEY.team;
  const nav = useNavigation();
  const visible = STAFF_LINKS.filter((l) => {
    const hit = findActive(nav.data, l.key);
    return !!hit && !hit.item.hidden;
  });
  const anyInTree = STAFF_LINKS.some((l) => !!findActive(nav.data, l.key));
  return (
    <div className="screen">
      <ScreenHead title={meta.title} description={meta.description} maxWidth={meta.descMaxWidth} />
      <div className="sys-tabs-col">
        <UsersTab />
        {visible.length ? (
          <div className="team-links" aria-label="Đánh giá và chăm sóc">
            {visible.map((l) => (
              <Link key={l.key} to={l.to} className="gh-card team-link">
                <Icon name={l.icon} size={18} />
                <span className="team-link__text">
                  <span className="team-link__title">{l.label}</span>
                  <span className="team-link__hint">{l.hint}</span>
                </span>
                <Icon name="ph ph-caret-right" size={13} />
              </Link>
            ))}
          </div>
        ) : anyInTree ? (
          <p className="muted-note team-note" role="note">
            Đánh giá và Chăm sóc hiện khi đã có ít nhất 1 nhân viên.
          </p>
        ) : null}
      </div>
    </div>
  );
}
