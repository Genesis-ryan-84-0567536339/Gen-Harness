import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PinCard } from '../../src/screens/system/PinCard';
import { qk } from '../../src/lib/queries';

/** v0.1.35: «Đổi mã PIN» khi PIN đang bị khoá — nói rõ bị khoá + giờ địa phương, không hiện ISO UTC thô. */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<PinCard> khi PIN bị khoá', () => {
  it('PUT /auth/pin → 423 PIN_LOCKED: hiện title + giờ theo múi giờ tổ chức', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('WebSocket', undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/auth/pin') && init?.method === 'PUT') {
          return new Response(
            JSON.stringify({
              type: 'https://gen-harness.local/errors/pin_locked',
              title: 'Mã PIN đang bị khoá do nhập sai nhiều lần',
              status: 423,
              code: 'PIN_LOCKED',
              detail: 'Thử lại sau ít phút',
              locked_until: '2026-10-02T08:15:00Z',
            }),
            { status: 423, headers: { 'Content-Type': 'application/problem+json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(qk.me, {
      id: 'u', email: 'owner@genesis.local', display_name: 'Owner', role: { code: 'owner', name: 'Owner' },
      org: { id: 'o', name: 'x', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
      addressing: { self: 'Anh', bot_calls_me: 'Sếp' }, pin_verified_until: null, permissions: {},
    });
    render(
      <QueryClientProvider client={qc}>
        <PinCard />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('button', { name: /Đổi mã PIN/ }));
    const dlg = await screen.findByRole('dialog', { name: /Đổi mã PIN/ });
    const d = within(dlg);
    await user.click(d.getByLabelText('PIN hiện tại — chữ số 1/6'));
    await user.keyboard('111111');
    await user.click(d.getByLabelText('PIN mới — chữ số 1/6'));
    await user.keyboard('246810');
    await user.click(d.getByLabelText('Nhập lại PIN mới — chữ số 1/6'));
    await user.keyboard('246810');
    await waitFor(() => expect(d.getByRole('button', { name: /Lưu mã mới/ })).toBeEnabled());
    await user.click(d.getByRole('button', { name: /Lưu mã mới/ }));
    await waitFor(() =>
      expect(d.getByText('Mã PIN đang bị khoá do nhập sai nhiều lần. Thử lại sau 02/10 15:15:00.')).toBeInTheDocument(),
    );
    expect(dlg.textContent).not.toContain('2026-10-02T08:15');
  });
});
