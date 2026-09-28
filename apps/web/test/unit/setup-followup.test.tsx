import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { qk } from '../../src/lib/queries';
import { SetupFollowUp } from '../../src/screens/queue/SetupFollowUp';

function state(skipped: number[]) {
  return {
    finished: true, current_step: 12, language: 'vi', mode: 'empty', owner_created: true, console_ready: true,
    steps: Array.from({ length: 12 }, (_, i) => ({
      n: i + 1, key: `k${i + 1}`, title: `Bước ${i + 1}`, required: i < 4 || i === 11,
      status: skipped.includes(i + 1) ? 'skipped' : 'done', available: true,
    })),
  };
}

function renderWith(skipped: number[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.setupState, state(skipped));
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SetupFollowUp />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Việc thiết lập tiếp (Tổng quan)', () => {
  beforeEach(() => localStorage.clear());

  it('liệt kê các bước đã "Để sau", mỗi bước có đường tới màn Console', () => {
    renderWith([5, 8, 11]);
    expect(screen.getByText('Việc thiết lập tiếp')).toBeInTheDocument();
    expect(screen.getByText('Bước 5')).toBeInTheDocument();
    expect(screen.getByText('Bước 8')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: /Làm ngay/ }).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/system?tab=channels', '/agents', '/system?tab=storage']);
  });

  it('không hiện gì khi không có bước nào để sau', () => {
    const { container } = renderWith([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('"Đã xong" ẩn mục và nhớ lại', async () => {
    renderWith([5, 6]);
    await userEvent.click(screen.getAllByRole('button', { name: 'Đã xong' })[0]);
    expect(screen.queryByText('Bước 5')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('gh.setupFollowUp.dismissed') ?? '[]')).toEqual([5]);
  });
});
