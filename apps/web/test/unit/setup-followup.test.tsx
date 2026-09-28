import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { SetupFollowUpItem } from '@gen-harness/contracts';
import { SetupFollowUp } from '../../src/screens/queue/SetupFollowUp';

function item(n: number, done: boolean): SetupFollowUpItem {
  return { n, key: `k${n}`, title: `Bước ${n}`, status: 'skipped', done };
}

function renderWith(items: SetupFollowUpItem[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['setup', 'follow-up'], items);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SetupFollowUp />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Việc thiết lập tiếp (Tổng quan)', () => {
  it('liệt kê bước chưa xong, mỗi bước có đường tới màn Console', () => {
    renderWith([item(5, false), item(8, false), item(11, false)]);
    expect(screen.getByText('Việc thiết lập tiếp')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: /Làm ngay/ }).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/system?tab=channels', '/agents', '/system?tab=storage']);
  });

  it('bước đã làm xong ở Console (done=true) tự biến mất', () => {
    renderWith([item(5, true), item(6, false)]);
    expect(screen.queryByText('Bước 5')).not.toBeInTheDocument();
    expect(screen.getByText('Bước 6')).toBeInTheDocument();
  });

  it('không hiện gì khi mọi việc đã xong', () => {
    const { container } = renderWith([item(5, true)]);
    expect(container).toBeEmptyDOMElement();
  });
});
