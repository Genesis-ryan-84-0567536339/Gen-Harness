import { useMemo } from 'react';
import { Outlet, useMatches } from 'react-router-dom';
import { DOMAINS, SCREEN_BY_KEY, type DomainId } from '@gen-harness/contracts';
import { useActiveScreenKey, type RouteHandle } from './routeHandles';
import { useNavigation } from '../lib/queries';
import { useRealtime } from '../lib/realtime';
import { useUiStore } from '../lib/uiStore';
import { Header, type Crumbs } from './Header';
import { findActive } from './navModel';
import { Sidebar } from './Sidebar';

function useCrumbs(activeKey: string | null): Crumbs | null {
  const matches = useMatches();
  const nav = useNavigation();
  return useMemo(() => {
    if (!activeKey) return null;
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
  useRealtime();
  return (
    <div className="app" data-sidebar={mode}>
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
    </div>
  );
}
