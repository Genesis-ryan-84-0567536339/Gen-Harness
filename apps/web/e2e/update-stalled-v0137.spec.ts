import { expect, test } from '@playwright/test';
import { loginAsOwner, resetMock } from './support';

/**
 * v0.1.37 (F-34) — 'running' mà tiến trình genh trên máy chủ đã chết (máy tắt/khởi động lại giữa chừng): api trả
 * `state: 'stalled'` + `stalled_reason: 'process_gone'`. Thẻ cập nhật nói "bị dừng giữa chừng" (không phải "máy chủ chưa
 * nhận yêu cầu") và "Thử lại" gửi lại yêu cầu cập nhật.
 */
function updateState(over: Record<string, unknown> = {}) {
  return {
    current: 'v0.1.36',
    latest: 'v0.1.37',
    update_available: true,
    updater: 'systemd',
    linked: true,
    can_request: true,
    state: 'stalled',
    stalled_reason: 'process_gone',
    message: null,
    from: 'v0.1.36',
    to: 'v0.1.37',
    started_at: new Date(Date.now() - 75 * 60_000).toISOString(),
    finished_at: null,
    requested_at: null,
    release_url: null,
    release_notes: null,
    published_at: null,
    auto_update_enabled: true,
    ...over,
  };
}

test.describe('v0.1.37 — cập nhật bị dừng giữa chừng', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request, 'finished');
    await loginAsOwner(page);
  });

  test('process_gone: thẻ "bị dừng giữa chừng", bấm Thử lại gửi POST /system/update', async ({ page }) => {
    let posts = 0;
    let state = updateState();
    await page.route('**/api/v1/system/update', async (route) => {
      const method = route.request().method();
      if (method === 'POST') {
        posts += 1;
        state = updateState({ state: 'requested', stalled_reason: null, requested_at: new Date().toISOString() });
        return route.fulfill({ status: 202, json: state });
      }
      if (method === 'GET') return route.fulfill({ json: state });
      return route.fallback();
    });
    await page.goto('/help');
    await expect(page.getByText('Cập nhật lên v0.1.37 bị dừng giữa chừng')).toBeVisible();
    await expect(page.getByText(/Tiến trình cập nhật trên máy chủ không còn chạy/)).toBeVisible();
    await expect(page.getByText('Máy chủ chưa nhận yêu cầu cập nhật')).toHaveCount(0);
    await expect(page.getByText('[object Object]')).toHaveCount(0);
    await page.getByRole('button', { name: /Thử lại/ }).click();
    await expect.poll(() => posts).toBe(1);
    await expect(page.getByText(/Đang cập nhật lên v0.1.37/)).toBeVisible();
  });
});
