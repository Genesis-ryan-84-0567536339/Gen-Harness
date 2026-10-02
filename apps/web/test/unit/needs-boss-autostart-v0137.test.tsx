import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { HealthIssue, SystemHealth } from '@gen-harness/contracts';
import { NeedsBossStrip } from '../../src/screens/queue/NeedsBossStrip';
import { HEALTH_KINDS } from '../../src/screens/system/queries';
import { qk } from '../../src/lib/queries';

/**
 * v0.1.37 (F-73): sự cố `host.autostart` (máy chủ chưa tự chạy lại Gen-Harness khi bật máy) — dải "Cần Sếp xử lý" hiện
 * dòng kèm lệnh cần chạy trên máy chủ, KHÔNG có nút (API trả link null — không có đích nào trong Console), và chuông
 * thuộc kind sự cố sức khoẻ (làm mới `/system/health` ngay khi nhận).
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const AUTOSTART: HealthIssue = {
  key: 'host.autostart', kind: 'host.autostart', severity: 'warn',
  title: 'Máy chủ chưa tự chạy lại Gen-Harness sau khi khởi động lại',
  body: 'Docker chưa bật tự chạy khi mở máy — chạy một lần trên máy chủ: sudo systemctl enable docker',
  link: null, action: 'Xem cách bật', raised_at: '2026-10-02T01:00:00Z',
};

function health(issues: HealthIssue[]): SystemHealth {
  return {
    checked_at: '2026-10-02T03:00:00Z', overall: 'warn',
    worker: { state: 'ok', alive: true, last_seen_at: null, silent_minutes: null },
    browser: { state: 'off', last_heartbeat_at: null }, queues: [], crons: [],
    backup: { configured: true, latest_at: '2026-10-02T02:00:00Z', age_hours: 1, stale: false },
    update: { state: 'idle', failed: false, blocked_version: null, finished_at: null },
    disk: { state: 'unknown', free_bytes: null, min_bytes: null, checked_at: null },
    issues,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('v0.1.37 — host.autostart', () => {
  it('dải hiện dòng warn kèm lệnh, không có nút/link chết, không "[object Object]"', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/system/health')) return json(200, health([AUTOSTART]));
      if (u.includes('/setup/follow-up')) return json(200, [{ n: 4, key: 'brain', title: 'Bộ não AI', status: 'done', done: true }]);
      return json(404, { title: 'Không tìm thấy', status: 404 });
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(qk.me, {
      id: 'u', email: 'owner@genesis.local', display_name: 'Anh Cơ', role: { code: 'owner', name: 'owner' },
      org: { id: 'o', name: 'x', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
      addressing: { self: 'Anh', bot_calls_me: 'Sếp' }, pin_verified_until: null,
      permissions: { 'overview.read': 'all', 'system.read': 'all', 'system.manage': 'all' },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><NeedsBossStrip /></MemoryRouter>
      </QueryClientProvider>,
    );
    const strip = await screen.findByTestId('needs-boss');
    const [row] = within(strip).getAllByTestId('needs-boss-row');
    expect(row).toHaveAttribute('data-severity', 'warn');
    expect(row).toHaveTextContent('Máy chủ chưa tự chạy lại Gen-Harness sau khi khởi động lại');
    expect(row).toHaveTextContent('sudo systemctl enable docker');
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(row).queryByRole('button')).toBeNull();
    expect(strip.textContent).not.toContain('[object Object]');
  });

  it('chuông host.autostart là kind sự cố sức khoẻ (làm mới /system/health ngay)', () => {
    expect(HEALTH_KINDS.has('host.autostart')).toBe(true);
  });
});
