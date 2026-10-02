import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@gen-harness/ui';
import { FOLLOW_UP_KEY } from '../../guide/guideContent';
import { api } from '../../lib/api';
import { useCan } from '../../lib/permissions';
import { sortIssues } from '../system/healthModel';
import { useSystemHealth } from '../system/queries';
import { NoModelNotice } from './NoModelBanner';
import { WARN } from './queueModel';

/**
 * v0.1.36 (F-6): dải "Cần Sếp xử lý" — ĐẦU Tổng quan, gom mọi việc Sếp phải tự tay làm vào một chỗ:
 * - "Chưa có model" (bước 4 của việc thiết lập tiếp chưa xong — API `GET /setup/follow-up` chỉ trả cho Owner);
 * - sự cố đang mở của `GET /system/health` (`issues` — kênh rớt, model hết đăng nhập, cập nhật lỗi, sao lưu quá hạn,
 *   Bộ xử lý nền im, ổ đĩa sắp đầy), 'bad' trước 'warn', mỗi dòng một nút đi thẳng tới chỗ sửa.
 * Chỉ vai trò có `system.manage` (Owner): mọi nút ở đây dẫn tới chỗ CHỈ người quản lý hệ thống làm được (Sao lưu ngay,
 * đăng nhập lại kênh/model, thử lại cập nhật). Vai trò chỉ có `system.read` (Auditor) không thấy dải — tình trạng vẫn
 * xem được ở thẻ "Sức khoẻ hệ thống" (Dữ liệu & lưu trữ), không có nút chết.
 * Không có gì ⇒ không vẽ gì. Lỗi tải sức khoẻ không chặn Tổng quan: bỏ qua phần đó (thẻ "Sức khoẻ hệ thống" ở
 * Dữ liệu & lưu trữ báo lỗi kèm "Chi tiết kỹ thuật").
 */
export function NeedsBossStrip() {
  const followUp = useQuery({ queryKey: FOLLOW_UP_KEY, queryFn: ({ signal }) => api.setup.followUp(signal) });
  const health = useSystemHealth(useCan('system.manage'));
  const step4 = Array.isArray(followUp.data) ? followUp.data.find((s) => s.n === 4) : undefined;
  const noModel = !!step4 && !step4.done;
  const issues = Array.isArray(health.data?.issues) ? sortIssues(health.data.issues) : [];
  if (!noModel && issues.length === 0) return null;
  return (
    <section className="needs-boss" aria-label="Cần Sếp xử lý" data-testid="needs-boss" data-gen-target="overview.needs_boss">
      <h2 className="needs-boss__title">
        <Icon name="ph ph-hand-palm" size={14} />
        Cần Sếp xử lý
      </h2>
      {noModel ? <NoModelNotice to="/guide/4" /> : null}
      {issues.length ? (
        <ul className="needs-boss__list">
          {issues.map((i) => (
            <li className="needs-boss__row" key={i.key} data-severity={i.severity} data-testid="needs-boss-row">
              <Icon
                name={i.severity === 'bad' ? 'ph ph-warning-octagon' : 'ph ph-warning'}
                size={16}
                color={i.severity === 'bad' ? 'var(--color-bad)' : WARN}
              />
              <div className="needs-boss__body">
                <div className="needs-boss__row-title">{String(i.title ?? '')}</div>
                {i.body ? <p className="needs-boss__text">{String(i.body)}</p> : null}
              </div>
              {typeof i.link === 'string' && i.link.startsWith('/') ? (
                <Link to={i.link} className={i.severity === 'bad' ? 'gh-btn gh-btn--primary btn-24' : 'gh-btn gh-btn--secondary btn-24'}>
                  {String(i.action || 'Xem')}
                  <Icon name="ph ph-arrow-right" size={11} />
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
