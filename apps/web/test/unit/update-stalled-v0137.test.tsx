import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { SystemHealth, SystemUpdate } from '@gen-harness/contracts';
import { UpdateCard } from '../../src/update/UpdateCard';
import { updateView } from '../../src/update/updateModel';
import { healthRows } from '../../src/screens/system/healthModel';
import { queryClient } from '../../src/lib/queryClient';

/**
 * v0.1.37 (F-34): 'running' mà tiến trình genh trên máy chủ đã chết ⇒ api trả 'stalled' + `stalled_reason:
 * 'process_gone'` — thẻ cập nhật nói "bị dừng giữa chừng" và cho Thử lại; mã genh GH-E94B (dừng do tín hiệu) / GH-E94A
 * (đang có lần cập nhật/khôi phục khác) có lời dẫn riêng, nguyên văn vẫn ở "Chi tiết kỹ thuật".
 */

const NOW = Date.parse('2026-10-02T10:00:00Z');
const base: SystemUpdate = {
  current: 'v0.1.36', latest: 'v0.1.37', update_available: true, updater: 'systemd', linked: true, can_request: true,
  state: 'idle', stalled_reason: null, message: null, from: null, to: null, started_at: null, finished_at: null,
  requested_at: null, release_url: null, release_notes: '- Tự lành',
};
const opts = { waitingFor: null, offline: false, now: NOW };

describe('updateView — stalled theo lý do', () => {
  it('process_gone: tiêu đề "bị dừng giữa chừng", hướng dẫn Thử lại, không hiện lệnh khi bấm được', () => {
    const v = updateView({ ...base, state: 'stalled', stalled_reason: 'process_gone' }, opts);
    if (v.kind !== 'stalled') throw new Error(v.kind);
    expect(v.title).toBe('Cập nhật lên v0.1.37 bị dừng giữa chừng');
    expect(v.kicker).toBe('Tiến trình cập nhật trên máy chủ không còn chạy — có thể máy vừa tắt hoặc khởi động lại');
    expect(v.body).toMatch(/Bấm Thử lại để chạy lại từ đầu/);
    expect(v.showCommand).toBe(false);
    const manual = updateView({ ...base, can_request: false, state: 'stalled', stalled_reason: 'process_gone' }, opts);
    expect(manual.kind !== 'hidden' && manual.showCommand).toBe(true);
  });
  it('not_picked_up / thiếu lý do (api cũ): giữ chữ cũ', () => {
    for (const reason of ['not_picked_up', null, undefined] as const) {
      const v = updateView({ ...base, state: 'stalled', stalled_reason: reason }, opts);
      if (v.kind !== 'stalled') throw new Error(v.kind);
      expect(v.title).toBe('Máy chủ chưa nhận yêu cầu cập nhật');
      expect(v.kicker).toMatch(/quá 15 phút/);
    }
  });
});

describe('failedCopy — mã GH-E94B / GH-E94A', () => {
  const failedAt = (message: string) =>
    updateView({ ...base, state: 'failed', to: 'v0.1.37', message, finished_at: '2026-10-02T09:00:00Z' }, opts);
  it('GH-E94B đã quay về: "dừng giữa chừng", không coi là bản hỏng; nguyên văn ở chi tiết', () => {
    const msg = 'Cập nhật bị dừng giữa chừng do tín hiệu dừng — đã tự quay về v0.1.36 (GH-E94B)';
    const v = failedAt(msg);
    if (v.kind !== 'failed') throw new Error(v.kind);
    expect(v.tone).toBe('warn');
    expect(v.kicker).toBe('Cập nhật bị dừng giữa chừng');
    expect(v.body).toMatch(/đã tự quay về bản đang dùng/);
    expect(v.body).toMatch(/không phải lỗi của bản mới/);
    expect(v.body).not.toMatch(/không tự cài lại/);
    expect(v.detail).toBe(msg);
  });
  it('GH-E94B chưa quay về: không nói "đã tự quay về"', () => {
    const v = failedAt('Cập nhật bị dừng giữa chừng do tín hiệu dừng (GH-E94B)');
    if (v.kind !== 'failed') throw new Error(v.kind);
    expect(v.kicker).toBe('Cập nhật bị dừng giữa chừng');
    expect(v.body).not.toMatch(/đã tự quay về/);
    expect(v.body).toMatch(/Chi tiết kỹ thuật/);
  });
  it('GH-E94A: đang có lần cập nhật/khôi phục khác chạy', () => {
    const msg = 'Đang có một lần cập nhật/khôi phục khác chạy — chờ xong rồi thử lại (GH-E94A)';
    const v = failedAt(msg);
    if (v.kind !== 'failed') throw new Error(v.kind);
    expect(v.kicker).toBe('Đang có một lần cập nhật/khôi phục khác chạy — chờ xong rồi thử lại');
    expect(v.kicker).not.toMatch(/quay về/);
    expect(v.detail).toBe(msg);
  });
});

describe('healthModel — dòng Cập nhật', () => {
  const health = (update: SystemHealth['update']): SystemHealth => ({
    checked_at: new Date(NOW).toISOString(), overall: 'warn',
    worker: { state: 'ok', alive: true, last_seen_at: null, silent_minutes: null },
    browser: { state: 'off', last_heartbeat_at: null }, queues: [], crons: [],
    backup: { configured: true, latest_at: new Date(NOW).toISOString(), age_hours: 0, stale: false },
    update, disk: { state: 'unknown', free_bytes: null, min_bytes: null, checked_at: null }, issues: [],
  });
  const row = (u: SystemHealth['update']) => healthRows(health(u), NOW).find((r) => r.key === 'update')!;
  it('stalled/process_gone ⇒ "Cập nhật bị dừng giữa chừng" (vàng); not_picked_up giữ chữ cũ', () => {
    const gone = row({ state: 'stalled', stalled_reason: 'process_gone', failed: false, blocked_version: null, finished_at: null });
    expect(gone.value).toBe('Cập nhật bị dừng giữa chừng');
    expect(gone.tone).toBe('warn');
    const stale = row({ state: 'stalled', stalled_reason: 'not_picked_up', failed: false, blocked_version: null, finished_at: null });
    expect(stale.value).toBe('Máy chủ chưa nhận yêu cầu cập nhật');
    expect(row({ state: 'running', stalled_reason: null, failed: false, blocked_version: null, finished_at: null }).value).toBe('Đang cập nhật');
  });
});

describe('<UpdateCard> — dừng giữa chừng', () => {
  beforeEach(() => {
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it('process_gone: thẻ hiện "bị dừng giữa chừng", bấm Thử lại gửi POST /system/update', async () => {
    const user = userEvent.setup();
    const stalled: SystemUpdate = { ...base, state: 'stalled', stalled_reason: 'process_gone', to: 'v0.1.37' };
    let posted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).endsWith('/system/update') && init?.method === 'POST') posted = true;
        const body = posted ? { ...stalled, state: 'requested', stalled_reason: null } : stalled;
        return new Response(JSON.stringify(body), {
          status: init?.method === 'POST' ? 202 : 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <UpdateCard />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Cập nhật lên v0.1.37 bị dừng giữa chừng')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Thử lại/ }));
    await waitFor(() => expect(posted).toBe(true));
    expect(await screen.findByText('Đang cập nhật lên v0.1.37')).toBeInTheDocument();
  });
});
