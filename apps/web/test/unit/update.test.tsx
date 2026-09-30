import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { SystemUpdate } from '@gen-harness/contracts';
import { UpdateCard } from '../../src/update/UpdateCard';
import { updateView } from '../../src/update/updateModel';
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

