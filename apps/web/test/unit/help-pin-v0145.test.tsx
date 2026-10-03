import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { HelpPage } from '../../src/help/HelpPage';
import { PIN_LIMITS } from '../../src/help/helpModel';
import { queryClient } from '../../src/lib/queryClient';

const me = (role: { code: string; name: string }) => ({
  id: 'u1', email: 'owner@genesis.local', display_name: 'Anh Cơ La (Ryan)', role,
  org: { id: 'o1', name: 'Genesis Trading', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
  addressing: { self: 'Anh', bot_calls_me: 'Sếp' }, pin_verified_until: null,
  permissions: role.code === 'owner' ? { 'system.read': 'all', 'system.manage': 'all' } : {}, must_change_password: false,
  features: { gen: false },
});

function stub(meBody: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith('/auth/me')
      ? meBody
      : url.endsWith('/system/about')
        ? { version: 'v0.1.45', org_name: 'Genesis Trading', timezone: 'Asia/Ho_Chi_Minh', role: { code: 'owner', name: 'Owner' } }
        : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

beforeEach(() => {
  queryClient.clear();
  vi.stubGlobal('WebSocket', undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('Trợ giúp — giới hạn của mã PIN (v0.1.45, F-60)', () => {
  it.each([
    { code: 'owner', name: 'Owner — Sếp' },
    { code: 'operator', name: 'Operator' },
  ])('vai trò $code thấy thẻ "Mã PIN bảo vệ được gì" (tiêu đề h2)', async (role) => {
    stub(me(role));
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <HelpPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const heading = await screen.findByRole('heading', { level: 2, name: 'Mã PIN bảo vệ được gì' });
    const card = screen.getByTestId('help-pin-limits');
    expect(card).toContainElement(heading);
    expect(within(card).getByText(/ai biết mật khẩu đăng nhập thì đặt lại được PIN/)).toBeInTheDocument();
    expect(card.textContent).toContain('Đáng ngờ');
    expect(card.textContent).toMatch(/mức tự trị.*tool MCP.*tài khoản CLI.*nhà cung cấp AI.*mời người/);
  });

  it('PIN_LIMITS: 3–4 câu ngắn', () => {
    expect(PIN_LIMITS.title).toBe('Mã PIN bảo vệ được gì');
    expect(PIN_LIMITS.points.length).toBeGreaterThanOrEqual(3);
    expect(PIN_LIMITS.points.length).toBeLessThanOrEqual(4);
  });
});
