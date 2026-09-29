import { useMemo } from 'react';
import { Navigate, Outlet, useMatches } from 'react-router-dom';
import { DOMAINS, SCREEN_BY_KEY, type DomainId } from '@gen-harness/contracts';
import { useActiveScreenKey, type RouteHandle } from './routeHandles';
import { useMe, useNavigation } from '../lib/queries';
import { useRealtime } from '../lib/realtime';
import { useUiStore } from '../lib/uiStore';
import { Header, type Crumbs } from './Header';
import { findActive } from './navModel';
import { Sidebar } from './Sidebar';
import { GenPanel } from '../gen/GenPanel';
import { Spotlight } from '../gen/Spotlight';
import { useGenStore } from '../gen/genStore';
import '../gen/genClient';

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
  useRealtime();
  // v0.1.21: khung Gen (cờ gen.enabled, v1 chỉ Owner) — mở/đóng nhớ theo từng người dùng.
  const genOn = !!me.data?.features?.gen;
  const genOpen = useGenStore((s) => (me.data ? !!s.openByUser[me.data.id] : false)) && genOn;
  // v0.1.19: mật khẩu tạm (genh reset-password) → mọi màn Console chuyển về "Đặt mật khẩu mới".
  if (me.data?.must_change_password) return <Navigate to="/change-password" replace />;
  return (
    <div className="app" data-sidebar={mode} data-gen={genOpen ? 'open' : undefined}>
      <a className="skip-link" href="#main">
        Bỏ qua tới nội dung
      </a>
      <Sidebar activeKey={activeKey} />
      <main className="main" id="main" tabIndex={-1}>
        <Header crumbs={crumbs} />
        <div className="content">
          <Outlet />
        </div>
      </main>
      {genOpen && me.data ? <GenPanel userId={me.data.id} /> : null}
      {genOn ? <Spotlight /> : null}
    </div>
  );
}
