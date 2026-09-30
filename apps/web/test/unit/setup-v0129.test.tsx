import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { NoModelBanner } from '../../src/screens/queue/NoModelBanner';
import { SkipBrainDialog } from '../../src/setup/Step4Brain';
import { SETUP_STEPS } from '../../src/setup/steps';

/** v0.1.29 (Boss 30/09, V2): bước 4 "Để sau" được — hộp cảnh báo + dải "Chưa có model" có nút sửa. */

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function renderUi(ui: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Bước 4 để sau', () => {
  it('bước 4 không còn bắt buộc (chỉ 1–3 + Hoàn tất)', () => {
    expect(SETUP_STEPS.filter((s) => s.required).map((s) => s.n)).toEqual([1, 2, 3, 12]);
  });

  it('hộp cảnh báo nói rõ Gen/sàng lọc sẽ không chạy; "Vẫn để sau" mới bỏ qua', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn();
    const close = vi.fn();
    renderUi(<SkipBrainDialog open hasTestedModel={false} onClose={close} onConfirm={confirm} />);
    const dlg = screen.getByRole('dialog');
    expect(dlg).toHaveTextContent('Gen (trợ lý) sẽ không trả lời và sàng lọc tin sẽ không chạy');
    expect(dlg).toHaveTextContent('Chưa có model');
    await user.click(screen.getByRole('button', { name: 'Quay lại chọn model' }));
    expect(close).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Vẫn để sau' }));
    expect(confirm).toHaveBeenCalled();
  });

  it('dải "Chưa có model" ở Tổng quan khi mục 4 chưa xong, nút mở /guide/4; có model thì ẩn', async () => {
    let done = false;
    vi.stubGlobal('fetch', vi.fn(async () => json(200, [{ n: 4, key: 'brain', title: 'Bộ não AI', status: 'skipped', done }])));
    const { unmount } = renderUi(<NoModelBanner />);
    const banner = await screen.findByTestId('no-model');
    expect(banner).toHaveTextContent('Chưa có model');
    expect(screen.getByRole('link', { name: /Chọn model/ })).toHaveAttribute('href', '/guide/4');
    unmount();
    done = true;
    renderUi(<NoModelBanner />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('no-model')).toBeNull();
  });
});
