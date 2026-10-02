import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { GEN_SCREEN_BY_KEY, GEN_TARGET_BY_ID } from '@gen-harness/contracts';
import { Sidebar } from '../../src/shell/Sidebar';
import { SystemScreen } from '../../src/screens/system/SystemScreen';
import { executeUiAction } from '../../src/gen/director';
import { setNavigator } from '../../src/lib/navigation';
import { qk } from '../../src/lib/queries';
import { useUiStore, useUrlStateStore } from '../../src/lib/uiStore';
import { buildNavigation } from '../mock-api';

/** v0.1.39 (F-32): trang Tài khoản mạng xã hội có mục riêng ở thanh bên, Gen mở được, và thẻ Facebook ở Hệ thống › Kênh. */

const OWNER = { code: 'owner', name: 'Owner — Sếp' };
const OPERATOR = { code: 'operator', name: 'Vận hành' };

function me(role: { code: string; name: string }, permissions: Record<string, string> = {}) {
  return {
    id: 'u', email: 'owner@genesis.local', display_name: 'Anh Cơ La (Ryan)',
    role,
    org: { id: 'o', name: 'x', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
    addressing: { self: 'Anh', bot_calls_me: 'Sếp' }, pin_verified_until: null, permissions,
  };
}

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname}</div>;
}

function renderSidebar(role: { code: string; name: string }, path = '/overview') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.navigation, buildNavigation());
  qc.setQueryData(qk.me, me(role));
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <Sidebar activeKey={path.slice(1)} />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderChannels(role: { code: string; name: string }, permissions: Record<string, string>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })),
  );
  useUrlStateStore.setState({ params: { tab: 'channels' } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.me, me(role, permissions));
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/system?tab=channels']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <SystemScreen />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useUiStore.setState({ sidebarMode: 'full', showEnglish: false, navOpen: {} });
  useUrlStateStore.setState({ params: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('v0.1.39 — mục "Mạng xã hội" ở thanh bên', () => {
  it('Owner (rộng): link "Mạng xã hội" trỏ /social, ngay sau Hướng dẫn thiết lập; bấm thì mở /social', async () => {
    renderSidebar(OWNER);
    const nav = screen.getByRole('navigation', { name: 'Danh mục màn hình' });
    const social = within(nav).getByRole('link', { name: /Mạng xã hội/ });
    expect(social).toHaveAttribute('href', '/social');
    expect(social).toHaveAttribute('title', expect.stringMatching(/^Tài khoản mạng xã hội — Facebook/));
    expect(social.closest('.sb-group')).toHaveAttribute('data-screen', 'social');
    const guide = within(nav).getByRole('link', { name: /Hướng dẫn thiết lập/ });
    expect(guide.closest('.sb-group')!.nextElementSibling).toBe(social.closest('.sb-group'));
    expect(social).not.toHaveAttribute('aria-current');
    await userEvent.setup().click(social);
    expect(screen.getByTestId('where')).toHaveTextContent('/social');
  });

  it('Owner (hẹp): mục chỉ có icon + tooltip, nhãn đọc màn hình "Mạng xã hội"; đang ở /social thì aria-current', () => {
    useUiStore.setState({ sidebarMode: 'rail' });
    renderSidebar(OWNER, '/social');
    const social = screen.getByRole('link', { name: 'Mạng xã hội' });
    expect(social).toHaveAttribute('href', '/social');
    expect(social).toHaveAttribute('aria-current', 'page');
    expect(within(social).queryByText('Mạng xã hội')).not.toBeInTheDocument();
  });

  it('Vận hành (Operator): không có mục "Mạng xã hội"', () => {
    renderSidebar(OPERATOR);
    expect(screen.queryByRole('link', { name: /Mạng xã hội/ })).not.toBeInTheDocument();
    expect(document.querySelector('[data-screen="social"]')).toBeNull();
  });
});

describe('v0.1.39 — Gen điều hướng tới /social', () => {
  it('registry có màn social và target thẻ Facebook', () => {
    expect(GEN_SCREEN_BY_KEY.social).toEqual({ key: 'social', path: '/social', title: 'Tài khoản mạng xã hội' });
    expect(GEN_SCREEN_BY_KEY.guide.title).toBe('Hướng dẫn thiết lập');
    expect(GEN_TARGET_BY_ID['system.channels.facebook']).toMatchObject({ screen: 'system', params: { tab: 'channels' }, permission: 'roles.manage' }); // chỉ Owner thấy thẻ → target chỉ Owner (Admin có system.manage không được chỉ tới)
  });

  it('hành động {type:navigate, screen:social} → navigateTo("/social")', async () => {
    const nav = vi.fn();
    setNavigator(nav);
    await executeUiAction({ type: 'navigate', screen: 'social' });
    expect(nav).toHaveBeenCalledWith('/social', undefined);
  });
});

describe('v0.1.39 — thẻ Facebook ở Hệ thống › Kênh', () => {
  it('Owner: có thẻ Facebook, link "Mở trang tài khoản mạng xã hội" tới /social', async () => {
    renderChannels(OWNER, { 'system.read': 'all', 'system.manage': 'all' });
    const card = await screen.findByRole('region', { name: 'Facebook' });
    expect(card).toHaveAttribute('data-gen-target', 'system.channels.facebook');
    expect(within(card).getByText('Đọc thông báo và tin nhắn — đăng nhập ngay trong app')).toBeInTheDocument();
    const link = within(card).getByRole('link', { name: /Mở trang tài khoản mạng xã hội/ });
    expect(link).toHaveAttribute('href', '/social');
    await userEvent.setup().click(link);
    expect(screen.getByTestId('where')).toHaveTextContent('/social');
  });

  it('Vận hành: không có thẻ Facebook', () => {
    renderChannels(OPERATOR, { 'system.read': 'all' });
    expect(screen.queryByRole('region', { name: 'Facebook' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-gen-target="system.channels.facebook"]')).toBeNull();
  });
});
