import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { NavDomain } from '@gen-harness/contracts';
import { findActive, groupAction, groupView, screenKeys } from '../../src/shell/navModel';
import { Sidebar } from '../../src/shell/Sidebar';
import { qk } from '../../src/lib/queries';
import { useUiStore } from '../../src/lib/uiStore';
import { buildNavigation } from '../mock-api';

const NAV: NavDomain[] = buildNavigation();
const business = NAV[0];
const queueGroup = business.groups.find((g) => g.name === 'Hàng đợi & Hành động')!;
const graph = business.groups.find((g) => g.key === 'graph')!;

describe('navModel', () => {
  it('finds the active screen, its domain and parent group', () => {
    const hit = findActive(NAV, 'workbench')!;
    expect(hit.domain.crumb).toBe('KINH DOANH');
    expect(hit.group.name).toBe('Hàng đợi & Hành động');
    expect(hit.isChild).toBe(true);
    expect(findActive(NAV, 'system')!.isChild).toBe(false);
    expect(findActive(NAV, 'nope')).toBeNull();
  });

  it('lists every screen key in the tree (21 design + 3 spec extras)', () => {
    expect(screenKeys(NAV).size).toBe(24);
  });

  it('auto-expands the group that contains the active screen', () => {
    expect(groupView(queueGroup, 'inbox', {}, true)).toMatchObject({ open: true, on: true, activeKid: true, self: false });
    expect(groupView(queueGroup, 'overview', {}, true)).toMatchObject({ open: false, on: false });
  });

  it('respects an explicit collapse even when the group contains the active screen', () => {
    expect(groupView(queueGroup, 'inbox', { 'Hàng đợi & Hành động': false }, true).open).toBe(false);
  });

  it('never shows children in rail mode', () => {
    expect(groupView(queueGroup, 'inbox', { 'Hàng đợi & Hành động': true }, false)).toMatchObject({ open: false, showCaret: false });
  });

  it('a pure group toggles in full mode, starting from its auto state', () => {
    expect(groupAction(queueGroup, 'overview', {}, true)).toEqual({ type: 'toggle', group: 'Hàng đợi & Hành động', open: true });
    expect(groupAction(queueGroup, 'inbox', {}, true)).toEqual({ type: 'toggle', group: 'Hàng đợi & Hành động', open: false });
  });

  it('a pure group opens its first child in rail mode', () => {
    expect(groupAction(queueGroup, 'overview', {}, false)).toEqual({ type: 'navigate', key: 'inbox' });
  });

  it('an entry that is also a screen opens it and expands (Bản đồ quan hệ)', () => {
    expect(groupAction(graph, 'overview', {}, true)).toEqual({ type: 'navigate', key: 'graph' });
    expect(groupView(graph, 'graph', {}, true)).toMatchObject({ self: true, open: true });
    expect(groupView(graph, 'profile', {}, true)).toMatchObject({ self: false, activeKid: true, open: true });
  });
});

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname}</div>;
}

function renderSidebar(nav: NavDomain[], path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.navigation, nav);
  qc.setQueryData(qk.me, {
    id: 'u', email: 'owner@genesis.local', display_name: 'Anh Cơ La (Ryan)',
    role: { code: 'owner', name: 'Owner — Sếp' },
    org: { id: 'o', name: 'x', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
    addressing: { self: 'Anh', bot_calls_me: 'Sếp' }, pin_verified_until: null, permissions: {},
  });
  const key = path.slice(1);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <Sidebar activeKey={key} />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<Sidebar>', () => {
  beforeEach(() => {
    useUiStore.setState({ sidebarMode: 'full', showEnglish: true, navOpen: {} });
  });

  it('renders exactly the domains, groups and badges the API returns', () => {
    renderSidebar(NAV, '/overview');
    const nav = screen.getByRole('navigation', { name: 'Danh mục màn hình' });
    expect(within(nav).getByText('Kinh doanh')).toBeInTheDocument();
    expect(within(nav).getByText('Kỹ thuật · Backend')).toBeInTheDocument();
    expect(within(nav).getByText('15 màn')).toBeInTheDocument();
    const overview = within(nav).getByRole('link', { name: /Tổng quan điều hành/ });
    expect(overview).toHaveAttribute('aria-current', 'page');
    expect(within(overview).getByText('9')).toBeInTheDocument();
    // children of collapsed groups are not rendered
    expect(within(nav).queryByText('Hộp thư ý nghĩa')).not.toBeInTheDocument();
    expect(screen.getByText('CL')).toBeInTheDocument();
    expect(screen.getByText('Owner · thấy toàn cảnh')).toBeInTheDocument();
  });

  it('role filtering: hides what the API leaves out', () => {
    renderSidebar(buildNavigation(new Set(['people', 'care', 'system'])), '/overview');
    expect(screen.queryByText('Con người & Chất lượng')).not.toBeInTheDocument();
    expect(screen.queryByText('Điều khiển hệ thống')).not.toBeInTheDocument();
    expect(screen.getByText('Plugin & Tiện ích')).toBeInTheDocument();
  });

  it('auto-expands the group of the active child and marks it', () => {
    renderSidebar(NAV, '/workbench');
    const group = screen.getByRole('button', { name: /Hàng đợi & Hành động/ });
    expect(group).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: /Bàn làm việc/ })).toHaveAttribute('aria-current', 'page');
  });

  it('a pure group only toggles; it does not navigate', async () => {
    const user = userEvent.setup();
    renderSidebar(NAV, '/overview');
    const group = screen.getByRole('button', { name: /Cơ hội & Thị trường/ });
    await user.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Bảng cơ hội')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/overview');
    await user.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Bảng cơ hội')).not.toBeInTheDocument();
  });

  it('an item that is also a screen navigates (and its children show once active)', async () => {
    const user = userEvent.setup();
    renderSidebar(NAV, '/overview');
    await user.click(screen.getByRole('link', { name: /Bản đồ quan hệ/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/graph');
  });

  it('rail mode hides labels and domain names; a group opens its first child', async () => {
    useUiStore.setState({ sidebarMode: 'rail' });
    const user = userEvent.setup();
    renderSidebar(NAV, '/overview');
    expect(screen.queryByText('Kinh doanh')).not.toBeInTheDocument();
    expect(screen.queryByText('GEN‑HARNESS')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tầng dữ liệu' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/raw');
  });

  it('shows an error state with retry when navigation fails', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryDefaults(qk.navigation, { queryFn: () => Promise.reject(new Error('boom')) });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Sidebar activeKey="overview" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return screen.findByText('Không tải được danh mục').then((el) => {
      expect(el).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Thử lại/ })).toBeInTheDocument();
    });
  });
});
