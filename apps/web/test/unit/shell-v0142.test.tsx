/**
 * v0.1.42: header gọn (F-67 — tự trị, khiên, Góc nhìn đã lưu chỉ ở Nâng cao), logo hiện phiên bản thật (F-67),
 * bỏ phụ đề tiếng Anh (F-63), Đội ngũ hiện lối vào Đánh giá/Chăm sóc theo /navigation, Tài khoản có Lịch sử nhập PIN.
 */
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { AccountPage } from '../../src/account/AccountPage';
import { qk } from '../../src/lib/queries';
import { useUiStore } from '../../src/lib/uiStore';
import { TeamScreen } from '../../src/screens/team/TeamScreen';
import { Header } from '../../src/shell/Header';
import { Sidebar } from '../../src/shell/Sidebar';
import { buildNavigation, permissionsOf, type RoleCode } from '../mock-api';

const STATUS = { channels_live: 2, groups_listening: 5, autonomy_level: 4, data_confidence: 0.78 };

function me(role: RoleCode) {
  return {
    id: 'u', email: `${role}@genesis.local`, display_name: 'Anh Cơ La (Ryan)', role: { code: role, name: role },
    org: { id: 'o', name: 'x', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
    addressing: { self: 'Anh', bot_calls_me: 'Sếp' }, pin_verified_until: null, permissions: permissionsOf(role),
  };
}

function renderWith(ui: ReactElement, role: RoleCode = 'owner', seed: (qc: QueryClient) => void = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.me, me(role));
  qc.setQueryData(qk.header, STATUS);
  seed(qc);
  // Data router: nút "Góc nhìn đã lưu" đọc useMatches.
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: ['/raw'] });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

let about: () => Response;
beforeEach(() => {
  useUiStore.setState({ sidebarMode: 'full', navOpen: {}, domainOpen: {} });
  about = () => new Response(JSON.stringify({ version: 'v0.1.42', image_version: 'v0.1.42', genh_version: 'v0.1.42', org_name: 'x', timezone: 'Asia/Ho_Chi_Minh', role: { code: 'owner', name: 'Owner' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal('WebSocket', undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/system/about')) return about();
      if (url.endsWith('/header')) return new Response(JSON.stringify(STATUS), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const CRUMBS = { domain: 'HẰNG NGÀY', group: null, title: 'Hôm nay', subtitle: 'Cần Sếp xử lý · 4 số chính' };

describe('Header (F-67, F-63)', () => {
  it('ngoài Nâng cao: chỉ viên "N kênh · M nhóm"; không tự trị, khiên, Góc nhìn đã lưu, phụ đề tiếng Anh', async () => {
    renderWith(<Header crumbs={CRUMBS} />);
    expect(await screen.findByText(/2 kênh · 5 nhóm/)).toBeInTheDocument();
    expect(screen.queryByText(/tự trị 4/)).toBeNull();
    expect(screen.queryByText('78%')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Góc nhìn đã lưu' })).toBeNull();
    expect(screen.queryByText('Cần Sếp xử lý · 4 số chính')).toBeNull();
  });

  it('màn Nâng cao: có tự trị, khiên %, Góc nhìn đã lưu', async () => {
    renderWith(<Header crumbs={{ ...CRUMBS, domain: 'NÂNG CAO', title: 'Kho dữ liệu thô' }} advanced />);
    expect(await screen.findByText(/2 kênh · 5 nhóm/)).toBeInTheDocument();
    expect(screen.getByText(/tự trị 4/)).toBeInTheDocument();
    expect(screen.getByText('78%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Góc nhìn đã lưu' })).toBeInTheDocument();
  });
});

describe('Logo + menu tài khoản (F-67, F-63)', () => {
  it('logo hiện "Gen-Harness · v0.1.42" từ /system/about; không còn "v2.2"', async () => {
    renderWith(<Sidebar activeKey="overview" />, 'owner', (qc) => qc.setQueryData(qk.navigation, buildNavigation()));
    expect(await screen.findByTestId('logo-version')).toHaveTextContent('Gen-Harness · v0.1.42');
    expect(document.body.textContent).not.toContain('v2.2');
  });

  it('/system/about lỗi → bỏ dòng phiên bản', async () => {
    about = () => new Response(JSON.stringify({ status: 500, code: 'INTERNAL', title: 'Lỗi' }), { status: 500, headers: { 'Content-Type': 'application/problem+json' } });
    renderWith(<Sidebar activeKey="overview" />, 'owner', (qc) => qc.setQueryData(qk.navigation, buildNavigation()));
    await screen.findByText('GEN‑HARNESS');
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('logo-version')).toBeNull();
    expect(document.body.textContent).not.toContain('v2.2');
  });

  it('menu tài khoản không còn "Phụ đề tiếng Anh"', async () => {
    const user = userEvent.setup();
    renderWith(<Sidebar activeKey="overview" />, 'owner', (qc) => qc.setQueryData(qk.navigation, buildNavigation()));
    await user.click(screen.getByRole('button', { name: /Anh Cơ La/ }));
    expect(screen.getByRole('menuitem', { name: /Tài khoản của tôi/ })).toBeInTheDocument();
    expect(screen.queryByText('Phụ đề tiếng Anh')).toBeNull();
  });
});

describe('Đội ngũ', () => {
  it('có nhân viên: thẻ liên kết Đánh giá con người, Chất lượng chăm sóc', async () => {
    renderWith(<TeamScreen />, 'owner', (qc) => qc.setQueryData(qk.navigation, buildNavigation()));
    expect(await screen.findByRole('heading', { name: 'Đội ngũ' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Đánh giá con người/ })).toHaveAttribute('href', '/people');
    expect(screen.getByRole('link', { name: /Chất lượng chăm sóc/ })).toHaveAttribute('href', '/care');
    expect(screen.queryByText('Đánh giá và Chăm sóc hiện khi đã có ít nhất 1 nhân viên.', { selector: 'p' })).toBeNull();
  });

  it('chưa có nhân viên: không có liên kết, có ghi chú', async () => {
    renderWith(<TeamScreen />, 'owner', (qc) => qc.setQueryData(qk.navigation, buildNavigation(new Set(), true, { hasStaff: false })));
    expect(await screen.findByText('Đánh giá và Chăm sóc hiện khi đã có ít nhất 1 nhân viên.', { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Đánh giá con người/ })).toBeNull();
  });
});

describe('Tài khoản của tôi — thẻ mã PIN (F-61)', () => {
  const ACCOUNT = {
    display_name: 'Anh Cơ La (Ryan)', email: 'owner@genesis.local', role: { code: 'owner', name: 'Owner' },
    created_at: '2026-05-04T02:15:00Z', must_change_password: false, has_pin: true, sessions: [],
  };
  it('audit.read → nút "Lịch sử nhập PIN" mở hộp lịch sử; không có audit.read → không có nút', async () => {
    const user = userEvent.setup();
    const seed = (qc: QueryClient) => qc.setQueryData(['account'], ACCOUNT);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.endsWith('/account') ? ACCOUNT : url.includes('/audit') ? { items: [], next_cursor: null } : [];
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    const view = renderWith(<AccountPage />, 'owner', seed);
    await user.click(await screen.findByRole('button', { name: /Lịch sử nhập PIN/ }));
    expect(await screen.findByRole('dialog', { name: /Lịch sử nhập PIN/ })).toBeInTheDocument();
    view.unmount();
    renderWith(<AccountPage />, 'operator', seed);
    await screen.findByRole('form', { name: 'Đổi mã PIN' });
    expect(screen.queryByRole('button', { name: /Lịch sử nhập PIN/ })).toBeNull();
  });
});
