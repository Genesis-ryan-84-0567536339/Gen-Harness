import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { SystemUpdate } from '@gen-harness/contracts';
import { UpdateCard } from '../../src/update/UpdateCard';
import { autoInstallHint, readableNotes, updateView } from '../../src/update/updateModel';
import { queryClient } from '../../src/lib/queryClient';

const base: SystemUpdate = {
  current: 'v0.1.16', latest: 'v0.1.17', update_available: true, updater: 'systemd', linked: true, can_request: true,
  state: 'idle', message: null, from: null, to: null, started_at: null, finished_at: null, requested_at: null,
  release_url: null, release_notes: '- Nút cập nhật',
};
const NOW = Date.parse('2026-09-28T10:00:00Z');

describe('updateView', () => {
  it('ẩn khi đã mới nhất, hiện "Có bản mới" khi có', () => {
    expect(updateView({ ...base, latest: 'v0.1.16', update_available: false }, { waitingFor: null, offline: false }).kind).toBe('hidden');
    const v = updateView(base, { waitingFor: null, offline: false });
    expect(v.kind).toBe('available');
    expect(v.kind !== 'hidden' && v.title).toBe('Có bản mới v0.1.17');
  });
  it('máy chủ chưa có watcher → hiện lệnh chạy tay thay vì nút', () => {
    const v = updateView({ ...base, can_request: false, updater: null }, { waitingFor: null, offline: false });
    expect(v.kind !== 'hidden' && v.showCommand).toBe(true);
  });
  it('đang cập nhật: requested → running → api tắt để khởi động lại → xong', () => {
    const steps = (d: SystemUpdate | undefined, offline = false) => {
      const v = updateView(d, { waitingFor: 'v0.1.17', offline, now: NOW });
      return v.kind === 'working' ? v.steps.map((s) => s.state) : v.kind;
    };
    expect(steps({ ...base, state: 'requested' })).toEqual(['active', 'todo', 'todo']);
    expect(steps({ ...base, state: 'running' })).toEqual(['done', 'active', 'todo']);
    expect(steps(undefined, true)).toEqual(['done', 'done', 'active']);
    expect(steps({ ...base, state: 'done', current: 'v0.1.17', update_available: false })).toBe('finished');
  });
  it('lỗi gần đây báo đã quay về bản cũ; yêu cầu treo quá lâu cho thử lại', () => {
    const failed = updateView({ ...base, state: 'failed', message: 'Pull lỗi', finished_at: '2026-09-28T09:00:00Z' }, { waitingFor: null, offline: false, now: NOW });
    expect(failed.kind).toBe('failed');
    expect(failed.kind !== 'hidden' && failed.kicker).toMatch(/quay về bản đang dùng/);
    const old = updateView({ ...base, state: 'failed', finished_at: '2026-09-20T09:00:00Z' }, { waitingFor: null, offline: false, now: NOW });
    expect(old.kind).toBe('available');
    expect(updateView({ ...base, state: 'stalled' }, { waitingFor: null, offline: false }).kind).toBe('stalled');
  });

  // v0.1.33: lịch đêm chỉ cài bản đã là bản chính thức ≥ 24 giờ — thẻ "Có bản mới" phải nói khi nào tự cài.
  it('"Có bản mới" báo lịch đêm tự cài khi nào (24 giờ sau khi thành bản chính thức) — hoặc bấm Cập nhật ngay', () => {
    const kicker = (d: SystemUpdate) => {
      const v = updateView(d, { waitingFor: null, offline: false, now: NOW });
      return v.kind === 'available' ? v.kicker : v.kind;
    };
    // Promote 2 giờ trước (08:00Z) ⇒ đủ 24 giờ lúc 29/09 08:00Z = 15:00 giờ Việt Nam.
    expect(kicker({ ...base, published_at: '2026-09-28T08:00:00Z' })).toBe(
      'Đang dùng v0.1.16 · Tự cài lúc ~03:00 sau 29/09 15:00 — hoặc bấm Cập nhật ngay',
    );
    // Đã đủ 24 giờ ⇒ lần ~03:00 tới.
    expect(kicker({ ...base, published_at: '2026-09-26T00:00:00Z' })).toBe('Đang dùng v0.1.16 · Tự cài lúc ~03:00 tới — hoặc bấm Cập nhật ngay');
    // Máy chủ chưa có watcher ⇒ không có nút, chỉ có lệnh.
    expect(kicker({ ...base, can_request: false, updater: null, published_at: '2026-09-28T08:00:00Z' })).toMatch(/— hoặc chạy lệnh bên dưới$/);
    // Không biết lúc phát hành (api cũ / lỗi) ⇒ giữ câu cũ.
    expect(kicker(base)).toBe('Đang dùng v0.1.16 · cập nhật mất khoảng 2–5 phút, tự sao lưu trước');
    expect(kicker({ ...base, published_at: 'không-phải-ngày' })).toBe('Đang dùng v0.1.16 · cập nhật mất khoảng 2–5 phút, tự sao lưu trước');
  });

  it('autoInstallHint: biên đúng 24 giờ tính là đã đủ', () => {
    expect(autoInstallHint('2026-09-27T10:00:00Z', NOW)).toBe('Tự cài lúc ~03:00 tới');
    expect(autoInstallHint('2026-09-27T10:00:01Z', NOW)).toMatch(/^Tự cài lúc ~03:00 sau 28\/09 17:00$/);
    expect(autoInstallHint(null, NOW)).toBeNull();
  });

  it('ghi chú phát hành không hiện dấu promote (chú thích HTML)', () => {
    expect(readableNotes('## Điểm mới\n- Nút cập nhật\n\n<!-- genh:promoted_at=2026-09-28T08:00:00Z -->\n')).toBe('## Điểm mới\n- Nút cập nhật');
  });
});

describe('<UpdateCard>', () => {
  beforeEach(() => {
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it('bấm Cập nhật ngay → xác nhận → gửi POST /system/update rồi hiện tiến trình', async () => {
    const user = userEvent.setup();
    let posted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const body = posted ? { ...base, state: 'requested' } : base;
        if (String(url).endsWith('/system/update') && init?.method === 'POST') posted = true;
        return new Response(JSON.stringify(posted ? { ...base, state: 'requested' } : body), {
          status: posted && init?.method === 'POST' ? 202 : 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <UpdateCard />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Có bản mới v0.1.17')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Cập nhật ngay/ }));
    expect(screen.getByText(/tự sao lưu dữ liệu trước/)).toBeInTheDocument();
    const confirm = screen.getAllByRole('button', { name: /Cập nhật ngay/ }).at(-1)!;
    await user.click(confirm);
    await waitFor(() => expect(posted).toBe(true));
    expect(await screen.findByText('Đang cập nhật lên v0.1.17')).toBeInTheDocument();
    expect(screen.getByText('Nhận yêu cầu')).toBeInTheDocument();
  });

  it('không có quyền (403) thì không hiện gì', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 403, code: 'FORBIDDEN', title: 'Không có quyền' }), { status: 403, headers: { 'Content-Type': 'application/problem+json' } })));
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <UpdateCard />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('v0.1.30 — mục "Cập nhật phần mềm" cố định', () => {
  beforeEach(() => {
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it('đã mới nhất: thẻ Tổng quan ẩn, mục cố định vẫn hiện; "Kiểm tra bản mới" gọi POST /system/update/check và hiện nút cập nhật', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    let latest = 'v0.1.16';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = String(url);
        calls.push(`${init?.method ?? 'GET'} ${u.replace(/^.*\/api\/v1/, '')}`);
        if (u.endsWith('/system/update/check')) latest = 'v0.1.17';
        const body = { ...base, latest, update_available: latest !== base.current, checked_at: '2026-09-28T10:00:00Z', throttled: false };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    const overview = render(
      <QueryClientProvider client={queryClient}>
        <UpdateCard />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(calls).toContain('GET /system/update'));
    await new Promise((r) => setTimeout(r, 30));
    expect(overview.container).toBeEmptyDOMElement();
    overview.unmount();

    render(
      <QueryClientProvider client={queryClient}>
        <UpdateCard always />
      </QueryClientProvider>,
    );
    const section = await screen.findByTestId('update-section');
    expect(screen.getByText('Cập nhật phần mềm')).toBeInTheDocument();
    expect(screen.getByText('Đang dùng bản mới nhất')).toBeInTheDocument();
    expect(section).toHaveTextContent('v0.1.16');
    expect(screen.queryByRole('button', { name: /Cập nhật ngay/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Kiểm tra bản mới/ }));
    await waitFor(() => expect(calls).toContain('POST /system/update/check'));
    expect(await screen.findByText('Có bản mới v0.1.17')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cập nhật ngay/ })).toBeInTheDocument();
  });
});

