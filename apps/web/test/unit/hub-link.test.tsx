import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { HubLink } from '@gen-harness/contracts';
import { HubLinkCard } from '../../src/screens/mcp/HubLinkCard';
import { expiryToIso, isoToDay } from '../../src/screens/mcp/mcpModel';
import { qk } from '../../src/lib/queries';

/** v0.1.26 — thẻ Gen-hub (Gen đọc Kho Ryan): token chỉ ghi, Kiểm tra bật liên kết, chỉ Owner cấu hình. */

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  url: string;
  method: string;
  body: unknown;
}
function mockFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const c = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(c);
      return handler(c);
    }),
  );
  return calls;
}

const me = (role: string) => ({
  id: 'u', email: 'x@genesis.local', display_name: 'Anh Cơ', role: { code: role, name: role },
  org: { id: 'o', name: 'x', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
  addressing: { self: 'Anh', bot_calls_me: 'Sếp' }, pin_verified_until: null,
  permissions: { 'system.read': 'all', 'system.manage': role === 'owner' ? 'all' : 'none' },
});

function renderCard(ui: ReactElement, role = 'owner') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.me, me(role));
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const OFF: HubLink = {
  configured: false, enabled: false, status: 'off', server_id: null, endpoint: null, has_token: false,
  allow_public_network: false, token_expires_at: null, days_left: null, last_ok_at: null, last_error: null, health: null,
};
const SAVED: HubLink = { ...OFF, configured: true, server_id: 's1', endpoint: 'https://hub.genos.top/mcp', has_token: true, allow_public_network: true, token_expires_at: '2026-12-28T16:59:00Z', days_left: 90 };
const TOKEN = 'ghtok_SieuBiMat_123456';

describe('Thẻ Gen-hub', () => {
  it('lần đầu: nhập địa chỉ + token → PATCH /hub/link, ô token xoá trắng, không hiện lại token', async () => {
    let state = OFF;
    const calls = mockFetch((c) => {
      if (c.url.includes('/hub/link') && c.method === 'GET') return json(200, state);
      if (c.url.includes('/hub/link') && c.method === 'PATCH') {
        state = SAVED;
        return json(200, SAVED);
      }
      return json(404);
    });
    const { container } = renderCard(<HubLinkCard />);
    expect(await screen.findByText('Chưa nối')).toBeInTheDocument();
    expect(screen.getByText('Đang tắt')).toBeInTheDocument();
    const user = userEvent.setup();
    const save = screen.getByRole('button', { name: 'Lưu' });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText('Địa chỉ Gen-hub'), 'https://hub.genos.top/mcp');
    const tokenInput = screen.getByLabelText('Token Gen-hub');
    expect(tokenInput).toHaveAttribute('type', 'password');
    expect(tokenInput).toHaveAttribute('data-gen-target', 'mcp.hub_link.token');
    await user.type(tokenInput, TOKEN);
    await user.click(screen.getByLabelText('Cho phép Gen-hub ở mạng công cộng'));
    await user.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ endpoint: 'https://hub.genos.top/mcp', token: TOKEN, allow_public_network: true });
    expect(await screen.findByText('Đã lưu (mã hoá, không hiện lại)')).toBeInTheDocument();
    expect(screen.getByLabelText('Token mới (bỏ trống để giữ token đã lưu)')).toHaveValue('');
    expect(container.innerHTML).not.toContain(TOKEN);
  });

  it('Kiểm tra → POST /hub/link/test, hiện kết quả và trạng thái "Đang nối"', async () => {
    const calls = mockFetch((c) => {
      if (c.url.includes('/hub/link/test') && c.method === 'POST') {
        return json(200, { ok: true, error: null, latency_ms: 312, exposed_tools: ['a__kho_tom_tat', 'a__kho_search'], missing_tools: [], link: { ...SAVED, enabled: true, status: 'ok' } });
      }
      if (c.url.includes('/hub/link') && c.method === 'GET') return json(200, SAVED);
      return json(404);
    });
    renderCard(<HubLinkCard />);
    const user = userEvent.setup();
    const btn = await screen.findByRole('button', { name: 'Kiểm tra' });
    expect(btn).toHaveAttribute('data-gen-target', 'mcp.hub_link.test');
    await user.click(btn);
    expect(await screen.findByText(/Đã nối Kho · 312 ms · mở 2 tool đọc cho Gen/)).toBeInTheDocument();
    expect(screen.getByText('Đang nối')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tắt' })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('Kiểm tra lỗi → hiện lý do; token hết hạn → trạng thái đỏ', async () => {
    mockFetch((c) => {
      if (c.url.includes('/hub/link/test')) {
        return json(200, { ok: false, error: '401: Token Gen-hub hết hạn hoặc đã bị thu hồi', latency_ms: 20, exposed_tools: [], missing_tools: [], link: { ...SAVED, status: 'expired', last_error: '401: Token Gen-hub hết hạn hoặc đã bị thu hồi' } });
      }
      if (c.url.includes('/hub/link')) return json(200, SAVED);
      return json(404);
    });
    renderCard(<HubLinkCard />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Kiểm tra' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Token Gen-hub hết hạn');
    expect(screen.getByText('Token hết hạn')).toBeInTheDocument();
  });

  it('vai trò khác Owner chỉ xem trạng thái, không có ô nhập', async () => {
    mockFetch((c) => (c.url.includes('/hub/link') ? json(200, { ...SAVED, enabled: true, status: 'expiring', days_left: 9 }) : json(404)));
    renderCard(<HubLinkCard />, 'auditor');
    expect(await screen.findByText('Token sắp hết hạn')).toBeInTheDocument();
    expect(screen.getByText('Chỉ Sếp (Owner) cấu hình và dùng Gen-hub.')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Token/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Kiểm tra' })).toBeNull();
  });

  it('ngày hết hạn: ô ngày ↔ ISO giờ VN', () => {
    expect(expiryToIso('2026-12-28')).toBe('2026-12-28T23:59:00+07:00');
    expect(expiryToIso('')).toBeNull();
    expect(isoToDay('2026-12-28T16:59:00Z')).toBe('2026-12-28');
    expect(isoToDay(null)).toBe('');
  });
});
