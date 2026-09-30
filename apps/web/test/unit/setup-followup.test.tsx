import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SetupFollowUpItem } from '@gen-harness/contracts';
import { SetupFollowUp } from '../../src/screens/queue/SetupFollowUp';
import { useUiStore } from '../../src/lib/uiStore';

const ME = (id: string, role: string) => ({
  id, email: `${id}@genesis.local`, display_name: id, role: { code: role, name: role },
  org: { id: 'o', name: 'x', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
  addressing: { self: 'Anh', bot_calls_me: 'Sếp' }, pin_verified_until: null, permissions: {},
});

function item(n: number, done: boolean): SetupFollowUpItem {
  return { n, key: `k${n}`, title: `Bước ${n}`, status: 'skipped', done };
}

function renderWith(items: SetupFollowUpItem[], me = ME('owner-1', 'owner')) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['setup', 'follow-up'], items);
  qc.setQueryData(['auth', 'me'], me);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SetupFollowUp />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Việc thiết lập tiếp (Tổng quan)', () => {
  beforeEach(() => useUiStore.setState({ followUpHiddenByUser: {} }));

  it('liệt kê bước chưa xong, mỗi bước mở thẳng form làm việc đó, đầu thẻ dẫn tới hướng dẫn từng bước', () => {
    renderWith([item(5, false), item(8, false), item(11, false)]);
    expect(screen.getByText('Việc thiết lập tiếp')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: /Làm ngay/ }).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/guide/5', '/guide/8', '/guide/11']);
    expect(screen.getByRole('link', { name: /Hướng dẫn từng bước/ })).toHaveAttribute('href', '/guide');
    expect(screen.getByText('Kết nối Zalo / WhatsApp')).toBeInTheDocument();
  });

  it('bước đã làm xong ở Console (done=true) tự biến mất', () => {
    renderWith([item(5, true), item(6, false)]);
    expect(screen.queryByText('Kết nối Zalo / WhatsApp')).not.toBeInTheDocument();
    expect(screen.getByText('Chọn nhóm cho agent lắng nghe')).toBeInTheDocument();
  });

  it('không hiện gì khi mọi việc đã xong', () => {
    const { container } = renderWith([item(5, true)]);
    expect(container).toBeEmptyDOMElement();
  });

  it('v0.1.30: "Ẩn" chỉ ẩn cho đúng người bấm; có bước dở MỚI thì hiện lại', async () => {
    const { unmount } = renderWith([item(5, false), item(8, false)]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Ẩn' }));
    expect(screen.queryByText('Việc thiết lập tiếp')).not.toBeInTheDocument();
    unmount();
    // Người khác (Owner khác) trên cùng trình duyệt vẫn thấy.
    const other = renderWith([item(5, false), item(8, false)], ME('owner-2', 'owner'));
    expect(screen.getByText('Việc thiết lập tiếp')).toBeInTheDocument();
    other.unmount();
    // Cùng người: bước đã ẩn làm xong bớt → vẫn ẩn; xuất hiện bước dở mới (10) → hiện lại.
    const same = renderWith([item(8, false)]);
    expect(screen.queryByText('Việc thiết lập tiếp')).not.toBeInTheDocument();
    same.unmount();
    renderWith([item(8, false), item(10, false)]);
    expect(screen.getByText('Việc thiết lập tiếp')).toBeInTheDocument();
  });

  it('v0.1.30: không phải Owner → không hiện (API /setup/* chỉ cho Owner)', () => {
    const { container } = renderWith([item(5, false)], ME('m', 'manager'));
    expect(container).toBeEmptyDOMElement();
  });
});
