import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { SetupFollowUpItem, SetupState } from '@gen-harness/contracts';
import { GuidePage } from '../../src/guide/GuidePage';
import { GuideStepPage } from '../../src/guide/GuideStepPage';
import { GUIDE } from '../../src/guide/guideContent';
import { queryClient } from '../../src/lib/queryClient';

const finished = (done: number[] = [], skipped: number[] = []): SetupState => ({
  finished: true,
  current_step: 12,
  steps: Array.from({ length: 12 }, (_, i) => ({
    n: i + 1,
    key: `s${i + 1}`,
    title: `Bước ${i + 1}`,
    required: i + 1 <= 4 || i + 1 === 12,
    status: done.includes(i + 1) || i + 1 <= 4 || i + 1 === 12 ? 'done' : skipped.includes(i + 1) ? 'skipped' : 'todo',
  })),
});

function followUp(done: number[]): SetupFollowUpItem[] {
  return [5, 6, 7, 8, 9, 10, 11].map((n) => ({ n, key: `k${n}`, title: `Bước ${n}`, status: done.includes(n) ? 'done' : 'skipped', done: done.includes(n) }));
}

describe('Hướng dẫn kết nối (/guide)', () => {
  it('mỗi việc 5–11 có chuẩn bị, các bước đánh số, dấu hiệu xong và nút mở đúng form', () => {
    for (const g of GUIDE) {
      expect(g.steps.length).toBeGreaterThanOrEqual(3);
      expect(g.prepare.length).toBeGreaterThan(0);
      expect(g.doneWhen).not.toBe('');
    }
    expect(GUIDE.map((g) => g.n)).toEqual([5, 6, 7, 8, 9, 10, 11]);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(['setup', 'follow-up'], followUp([5, 7]));
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <GuidePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Đã xong 2/7 việc')).toBeInTheDocument();
    expect(screen.getAllByText('Đã xong')).toHaveLength(2);
    // Việc chưa xong đầu tiên (06) mở sẵn; việc đã xong thì nút đổi thành "Làm lại / chỉnh".
    const cards = screen.getAllByRole('listitem').filter((li) => li.classList.contains('guide-card'));
    expect(cards[1].querySelector('details')).toHaveAttribute('open');
    expect(cards[0].querySelector('details')).not.toHaveAttribute('open');
    expect(within(cards[1]).getByRole('link', { name: /Làm bước này/ })).toHaveAttribute('href', '/guide/6');
    expect(within(cards[0]).getByRole('link', { name: /Làm lại/ })).toHaveAttribute('href', '/guide/5');
    expect(within(cards[1]).getByRole('link', { name: /Hoặc làm ở Nhóm & Con người/ })).toHaveAttribute('href', '/directory');
    // Việc 09 cần agent (việc 08) chưa có → nhắc làm 08 trước.
    expect(within(cards[4]).getByText(/Nên làm việc 08 trước/)).toBeInTheDocument();
  });
});

describe('Làm một việc từ hướng dẫn (/guide/:n) — sau khi đã Hoàn tất', () => {
  beforeEach(() => {
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it('bước 11 mở đúng form sao lưu, lưu được sau Hoàn tất rồi quay về trang hướng dẫn', async () => {
    const user = userEvent.setup();
    let saved: unknown = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = String(url);
        const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (u.endsWith('/setup/steps/11') && init?.method === 'PUT') {
          saved = JSON.parse(String(init.body));
          return reply({ ...finished([11], [5, 6, 7, 8, 9, 10]), backup: saved });
        }
        if (u.endsWith('/setup/follow-up')) return reply(followUp(saved ? [11] : []));
        return reply(finished([], [5, 6, 7, 8, 9, 10, 11]));
      }),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/guide/11']}>
          <Routes>
            <Route path="/guide" element={<GuidePage />} />
            <Route path="/guide/:n" element={<GuideStepPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const time = await screen.findByLabelText('Giờ chạy (HH:MM)');
    expect(screen.queryByRole('button', { name: 'Để sau' })).not.toBeInTheDocument();
    await user.clear(time);
    await user.type(time, '03:30');
    await user.click(screen.getByRole('button', { name: /Tiếp tục/ }));
    await waitFor(() => expect(saved).toMatchObject({ frequency: 'daily', time_of_day: '03:30' }));
    expect(await screen.findByText('Đã xong 1/7 việc')).toBeInTheDocument();
  });

  it('số việc không có trong hướng dẫn thì về trang hướng dẫn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(followUp([])), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/guide/3']}>
          <Routes>
            <Route path="/guide" element={<GuidePage />} />
            <Route path="/guide/:n" element={<GuideStepPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Đã xong 0/7 việc')).toBeInTheDocument();
  });
});
