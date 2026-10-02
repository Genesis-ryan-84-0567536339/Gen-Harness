import { useEffect, useMemo } from 'react';
import { Navigate, Outlet, useLocation, useMatches, useNavigate } from 'react-router-dom';
import { DOMAINS, SCREEN_BY_KEY, type DomainId } from '@gen-harness/contracts';
import { useActiveScreenKey, type RouteHandle } from './routeHandles';
import { useMe, useNavigation } from '../lib/queries';
import { useRealtime } from '../lib/realtime';
import { useUiStore } from '../lib/uiStore';
import { Header, type Crumbs } from './Header';
import { findActive } from './navModel';
import { Sidebar } from './Sidebar';
import { ErrorBoundary } from './ErrorPage';
import { GenPanel } from '../gen/GenPanel';
import { Spotlight } from '../gen/Spotlight';
import { useGenStore } from '../gen/genStore';
import { loadConversation } from '../gen/genClient';
import { toast } from '../lib/toast';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * v0.1.41 (F-8): mở Bản tin Gen từ chuông — link `/overview?gen=<conversation_id>`. Mở khung Gen, tải hội thoại rồi
 * bỏ tham số `gen` khỏi địa chỉ (replace — nút Lùi không mở lại). Mã sai dạng ⇒ bỏ qua (chỉ gỡ tham số).
 */
function useOpenGenFromUrl(userId: string | null, genOn: boolean): void {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (!userId || !genOn) return;
    const params = new URLSearchParams(search);
    const cid = params.get('gen');
    if (cid === null) return;
    params.delete('gen');
    const rest = params.toString();
    navigate(pathname + (rest ? `?${rest}` : ''), { replace: true });
    if (!UUID_RE.test(cid)) return;
    useGenStore.getState().setOpen(userId, true);
    const fail = () => toast('Không mở được bản tin — có thể đã quá hạn lưu', 'bad');
    loadConversation(cid, userId).then((ok) => (ok ? undefined : fail()), fail);
  }, [userId, genOn, pathname, search, navigate]);
}

function useCrumbs(activeKey: string | null): Crumbs | null {
  const matches = useMatches();
  const nav = useNavigation();
  return useMemo(() => {
    if (!activeKey) {
      const page = [...matches].reverse().map((m) => (m.handle as RouteHandle | undefined)?.page).find(Boolean);
      return page ? { domain: page.domain, group: null, title: page.title, subtitle: page.subtitle } : null;
    }
    const meta = SCREEN_BY_KEY[activeKey];
    let domainId: DomainId | undefined;
    let group: string | null = null;
    for (const m of matches) {
      const h = m.handle as RouteHandle | undefined;
      if (h?.domain) domainId = h.domain;
      if (h?.group) group = h.group;
    }
    // Prefer the server tree (labels are the API's), fall back to the route tree.
    const hit = findActive(nav.data, activeKey);
    return {
      domain: hit?.domain.crumb ?? (domainId ? DOMAINS[domainId].crumb : ''),
      group: hit ? (hit.isChild ? hit.group.name : null) : group,
      title: meta?.title ?? hit?.item.name ?? activeKey,
      subtitle: meta?.subtitle ?? hit?.item.en ?? '',
    };
  }, [activeKey, matches, nav.data]);
}

export function AppShell() {
  const mode = useUiStore((s) => s.sidebarMode);
  const activeKey = useActiveScreenKey();
  const crumbs = useCrumbs(activeKey);
  const me = useMe();
  const { pathname } = useLocation();
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  useRealtime();
  // B4: ngăn kéo danh mục (điện thoại) tự đóng khi đổi trang; Esc cũng đóng.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname, setDrawerOpen]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen, setDrawerOpen]);
  // v0.1.21: khung Gen (cờ gen.enabled, v1 chỉ Owner) — mở/đóng nhớ theo từng người dùng.
  const genOn = !!me.data?.features?.gen;
  const genOpen = useGenStore((s) => (me.data ? !!s.openByUser[me.data.id] : false)) && genOn;
  // Điện thoại: khung Gen phủ cả màn — khi Gen đang chỉ vào một phần tử thì tạm ẩn khung để thấy phần tử (gen.css).
  const spotting = useGenStore((s) => !!s.spotlight);
  useOpenGenFromUrl(me.data?.id ?? null, genOn);
  // v0.1.19: mật khẩu tạm (genh reset-password) → mọi màn Console chuyển về "Đặt mật khẩu mới".
  if (me.data?.must_change_password) return <Navigate to="/change-password" replace />;
  return (
    <div
      className="app"
      data-sidebar={mode}
      data-gen={genOpen ? 'open' : undefined}
      data-drawer={drawerOpen ? 'open' : undefined}
      data-spot={spotting ? 'on' : undefined}
    >
      <a className="skip-link" href="#main">
        Bỏ qua tới nội dung
      </a>
      <Sidebar activeKey={activeKey} />
      {drawerOpen ? <div className="sb-backdrop" aria-hidden onClick={() => setDrawerOpen(false)} /> : null}
      <main className="main" id="main" tabIndex={-1}>
        <Header crumbs={crumbs} />
        <div className="content">
          {/* B5: màn lỗi chỉ thay vùng nội dung — thanh bên/header vẫn dùng được; đổi trang là thử vẽ lại. */}
          <ErrorBoundary variant="inline" resetKey={pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>
      {genOpen && me.data ? <GenPanel userId={me.data.id} /> : null}
      {genOn ? <Spotlight /> : null}
    </div>
  );
}
