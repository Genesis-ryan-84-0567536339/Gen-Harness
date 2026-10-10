/**
 * v0.1.55 (G5) — khung Mặt tiền Owner (`/owner/*`): anh em với khung Console (AppShell), mobile-first.
 *
 * - Tự kiểm phiên bằng các hook sẵn có như AppShell (không chép logic): 401 → `apiClient` đưa về /login, 428 → /setup,
 *   mật khẩu tạm (`must_change_password`) → /change-password, vai KHÁC Owner → về "/" (HomeRedirect chọn màn đầu của vai đó).
 * - Máy tính: thanh trái 6 mục (Hôm nay, Việc, Quan hệ, Hỏi Gen, Phân tích "sắp có" mờ, Thêm). Dưới 760px: thanh dưới
 *   5 nút (bỏ mục "sắp có").
 * - `?gen=` (link chuông): dùng lại `useOpenGenFromUrl` của AppShell — `?gen=coach` đáp ở Hôm nay (thẻ Hôm nay của Sếp),
 *   `?gen=<mã hội thoại>` đáp ở Hỏi Gen; Gen tắt ⇒ `/guide/viec-sep` như hiện nay.
 * - Chỉ dùng token + @gen-harness/ui + Panel; CSS riêng trong owner.css; không thư viện biểu đồ.
 */
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { Icon, Skeleton, cx } from '@gen-harness/ui';
import { Spotlight } from '../gen/Spotlight';
import { useMe } from '../lib/queries';
import { useRealtime } from '../lib/realtime';
import { useIsMobile } from '../lib/useMediaQuery';
import { ErrorBoundary } from '../shell/ErrorPage';
import { Logo } from '../shell/Logo';
import { NotificationBell } from '../shell/NotificationBell';
import { ThemeToggle } from '../shell/ThemeToggle';
import {
  OWNER_NAV,
  OWNER_PATHS,
  OWNER_TABBAR,
  SOON_LABEL,
  activeNavKey,
  ownerTitle,
  type OwnerNavItem,
} from './ownerModel';
import { OwnerError } from './parts';
import { useOpenGenFromUrl } from './useOpenGenFromUrl';
import './owner.css';

export function OwnerShell() {
  const me = useMe();
  const { pathname } = useLocation();
  const mobile = useIsMobile();
  useRealtime();
  const genOn = !!me.data?.features?.gen;
  useOpenGenFromUrl(me.data?.id ?? null, genOn, { coachPath: OWNER_PATHS.today, conversationPath: OWNER_PATHS.gen });

  if (me.isPending) return <OwnerBoot />;
  if (me.isError) {
    return (
      <div className="owner-boot" data-testid="owner-shell-error">
        <OwnerError error={me.error} onRetry={() => void me.refetch()} retrying={me.isFetching} />
      </div>
    );
  }
  // v0.1.19: mật khẩu tạm → mọi màn chuyển về "Đặt mật khẩu mới".
  if (me.data.must_change_password) return <Navigate to="/change-password" replace />;
  // Chỉ Owner có Mặt tiền; vai khác về "/" (HomeRedirect đưa tới màn đầu tiên của vai đó).
  if (me.data.role?.code !== 'owner') return <Navigate to="/" replace />;

  const active = activeNavKey(pathname);
  return (
    <div className="owner-app" data-mobile={mobile || undefined} data-screen={active}>
      <a className="skip-link" href="#owner-main">
        Bỏ qua tới nội dung
      </a>
      {mobile ? null : <OwnerRail active={active} />}
      <div className="owner-body">
        <header className="owner-top">
          <h1 className="owner-top__title">{ownerTitle(pathname)}</h1>
          <div className="owner-top__right">
            <NotificationBell />
            <ThemeToggle />
          </div>
        </header>
        <main className="owner-main" id="owner-main" tabIndex={-1}>
          <ErrorBoundary variant="inline" resetKey={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      {mobile ? <OwnerTabbar active={active} /> : null}
      {genOn ? <Spotlight /> : null}
    </div>
  );
}

function OwnerBoot() {
  return (
    <div className="owner-boot" aria-busy="true" aria-label="Đang mở Mặt tiền" data-testid="owner-boot">
      <Skeleton width={180} height={14} />
      <Skeleton width="100%" height={92} radius={14} style={{ marginTop: 14 }} />
      <Skeleton width="100%" height={92} radius={14} style={{ marginTop: 10 }} />
    </div>
  );
}

function OwnerRail({ active }: { active: OwnerNavItem['key'] }) {
  return (
    <aside className="owner-rail" aria-label="Thanh bên Mặt tiền">
      <Link to={OWNER_PATHS.today} className="owner-rail__logo" aria-label="Về Hôm nay">
        <Logo wide version={null} />
      </Link>
      <nav className="owner-rail__nav" aria-label="Mặt tiền">
        {OWNER_NAV.map((item) =>
          item.soon ? (
            <button key={item.key} type="button" className="owner-nav owner-nav--soon" disabled aria-disabled="true" title="Màn này sắp có">
              <Icon name={item.icon} size={16} />
              <span className="owner-nav__name">{item.label}</span>
              <span className="owner-nav__soon">{SOON_LABEL}</span>
            </button>
          ) : (
            <NavLink
              key={item.key}
              to={item.to}
              end={item.to === OWNER_PATHS.today}
              className={cx('owner-nav')}
              data-on={active === item.key || undefined}
              aria-current={active === item.key ? 'page' : undefined}
              data-testid={`owner-nav-${item.key}`}
            >
              <Icon name={item.icon} size={16} />
              <span className="owner-nav__name">{item.label}</span>
            </NavLink>
          ),
        )}
      </nav>
    </aside>
  );
}

function OwnerTabbar({ active }: { active: OwnerNavItem['key'] }) {
  return (
    <nav className="owner-tabbar" aria-label="Thanh dưới" data-testid="owner-tabbar">
      {OWNER_TABBAR.map((item) => (
        <NavLink
          key={item.key}
          to={item.to}
          end={item.to === OWNER_PATHS.today}
          className="owner-tab-btn"
          data-on={active === item.key || undefined}
          aria-current={active === item.key ? 'page' : undefined}
          data-testid={`owner-tabbar-${item.key}`}
        >
          <Icon name={item.icon} size={20} />
          <span className="owner-tab-btn__name">{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
