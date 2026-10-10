/**
 * v0.1.55 (G5) — `/owner/them`: màn Thêm. Trạng thái kết nối MỘT dòng cho mỗi dịch vụ (lấy từ "Việc Sếp cần làm" — cùng
 * khoá cache với trang đó), Facebook → /social, "Cài đặt nâng cao" → /overview (KHÔNG link '/' vì '/' của Owner nay về Mặt tiền),
 * kèm vài lối tắt (Tài khoản, Trợ giúp, Hướng dẫn thiết lập) và Đăng xuất.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Icon } from '@gen-harness/ui';
import { BOSS_CHECKS_KEY } from '../guide/bossChecksModel';
import { api } from '../lib/api';
import { useMe } from '../lib/queries';
import { queryClient } from '../lib/queryClient';
import { Panel } from '../screens/common';
import { ADVANCED_SETTINGS_PATH, connectionLines, safeLink } from './ownerModel';
import { ListSkeleton, OwnerEmpty, OwnerError, RowLink } from './parts';
import { useIsOwnerRole } from './queries';

const SHORTCUTS = [
  { to: '/account', label: 'Tài khoản của tôi', icon: 'ph ph-user-circle' },
  { to: '/help', label: 'Trợ giúp', icon: 'ph ph-question' },
  { to: '/guide', label: 'Hướng dẫn thiết lập', icon: 'ph ph-list-checks' },
] as const;

export function MoreScreen() {
  const owner = useIsOwnerRole();
  const me = useMe();
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);
  const boss = useQuery({ queryKey: BOSS_CHECKS_KEY, queryFn: ({ signal }) => api.bossChecks.list(signal), enabled: owner });
  useEffect(() => {
    document.title = 'Thêm · Gen-Harness';
  }, []);

  const lines = connectionLines(boss.data?.rows);
  const logout = async () => {
    setLeaving(true);
    try {
      await api.auth.logout();
    } catch {
      // phiên đã mất thì cũng về trang đăng nhập
    }
    queryClient.clear();
    navigate('/login', { replace: true });
  };

  return (
    <div className="owner-screen" data-testid="owner-more">
      <Panel title="Kết nối" kicker="Một dòng cho mỗi dịch vụ — bấm để xem hoặc nối lại" flush>
        <div data-testid="owner-connections">
          {boss.isPending ? (
            <ListSkeleton rows={4} label="Đang tải trạng thái kết nối" />
          ) : boss.isError ? (
            <OwnerError error={boss.error} onRetry={() => void boss.refetch()} retrying={boss.isFetching} />
          ) : lines.length === 0 ? (
            <OwnerEmpty icon="ph ph-plugs" title="Chưa có dịch vụ nào để hiện" hint="Sếp nối Gen-hub, Facebook, Telegram… ở Hướng dẫn thiết lập." />
          ) : (
            <div className="owner-list">
              {lines.map((l) => (
                <RowLink
                  key={l.key}
                  to={l.to}
                  title={l.title}
                  right={l.text}
                  tone={l.state === 'ok' ? 'ok' : l.state === 'todo' ? 'warn' : undefined}
                  lead={<span className="owner-dot" data-state={l.state} aria-hidden />}
                  testId="owner-conn-row"
                />
              ))}
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Cài đặt nâng cao" kicker="Bộ não AI, sao lưu, quyền, nhật ký… — toàn bộ Console" flush>
        <div className="owner-advanced">
          <Link to={safeLink(ADVANCED_SETTINGS_PATH)} className="gh-btn gh-btn--primary" data-testid="owner-advanced">
            <Icon name="ph ph-gear-six" size={14} /> Cài đặt nâng cao
          </Link>
          <span className="owner-muted">Ở đó có nút “Về Mặt tiền” để quay lại.</span>
        </div>
      </Panel>

      <Panel title={me.data?.display_name ? `Tài khoản · ${me.data.display_name}` : 'Tài khoản'} flush>
        <div className="owner-list">
          {SHORTCUTS.map((s) => (
            <RowLink key={s.to} to={s.to} title={s.label} lead={<Icon name={s.icon} size={16} />} />
          ))}
        </div>
        <div className="owner-advanced">
          <Button variant="secondary" icon="ph ph-sign-out" loading={leaving} onClick={() => void logout()}>
            Đăng xuất
          </Button>
        </div>
      </Panel>
    </div>
  );
}
