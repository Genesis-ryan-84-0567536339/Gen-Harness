import { expect, test } from '@playwright/test';
import { loginAsOwner, mockHook, resetMock } from './support';

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

  test('not_picked_up: giữ chữ cũ "Máy chủ chưa nhận yêu cầu cập nhật"', async ({ page }) => {
    const state = updateState({ stalled_reason: 'not_picked_up', started_at: null, requested_at: new Date(Date.now() - 20 * 60_000).toISOString() });
    await page.route('**/api/v1/system/update', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: state }) : route.fallback()));
    await page.goto('/help');
    await expect(page.getByText('Máy chủ chưa nhận yêu cầu cập nhật')).toBeVisible();
    await expect(page.getByText(/bị dừng giữa chừng/)).toHaveCount(0);
    await expect(page.getByText('[object Object]')).toHaveCount(0);
  });

  for (const c of [
    {
      code: 'GH-E94B',
      message: 'Cập nhật bị dừng giữa chừng do tín hiệu dừng — đã tự quay về v0.1.36 (GH-E94B)',
      kicker: 'Cập nhật bị dừng giữa chừng',
    },
    {
      code: 'GH-E94A',
      message: 'Đang có một lần cập nhật/khôi phục khác chạy — chờ xong rồi thử lại (GH-E94A)',
      kicker: 'Đang có một lần cập nhật/khôi phục khác chạy — chờ xong rồi thử lại',
    },
  ]) {
    test(`${c.code}: lời dẫn riêng, nguyên văn ở "Chi tiết kỹ thuật"`, async ({ page }) => {
      const state = updateState({ state: 'failed', stalled_reason: null, message: c.message, finished_at: new Date(Date.now() - 10 * 60_000).toISOString() });
      await page.route('**/api/v1/system/update', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: state }) : route.fallback()));
      await page.goto('/help');
      await expect(page.getByText(c.kicker, { exact: true }).first()).toBeVisible();
      await page.getByText('Chi tiết kỹ thuật').first().click();
      await expect(page.getByText(c.message).first()).toBeVisible();
      await expect(page.getByText('[object Object]')).toHaveCount(0);
    });
  }

  test('thẻ Sức khoẻ: cập nhật stalled/process_gone ⇒ dòng "Cập nhật bị dừng giữa chừng"', async ({ page }) => {
    await mockHook(page.request, 'health', { update: { state: 'stalled', stalled_reason: 'process_gone', failed: false } });
    await page.goto('/system?tab=storage');
    const card = page.getByRole('region', { name: 'Sức khoẻ hệ thống' });
    await expect(card.getByText('Cập nhật bị dừng giữa chừng')).toBeVisible();
    await expect(page.getByText('[object Object]')).toHaveCount(0);
  });

  test('host.autostart: dải "Cần Sếp xử lý" có dòng kèm lệnh, KHÔNG có nút chết', async ({ page }) => {
    await mockHook(page.request, 'health', { issues: [{ kind: 'host.autostart' }] });
    await page.goto('/overview');
    const strip = page.getByRole('region', { name: 'Cần Sếp xử lý' });
    const rows = strip.getByTestId('needs-boss-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-severity', 'warn');
    await expect(rows.first()).toContainText('Máy chủ chưa tự chạy lại Gen-Harness sau khi khởi động lại');
    await expect(rows.first()).toContainText('sudo systemctl enable docker');
    await expect(rows.first()).toContainText('sudo loginctl enable-linger $USER');
    // Lệnh chạy trên máy chủ ⇒ không có đích trong Console: không vẽ nút/link nào.
    await expect(rows.first().getByRole('link')).toHaveCount(0);
    await expect(rows.first().getByRole('button')).toHaveCount(0);
    await expect(page.getByText('[object Object]')).toHaveCount(0);
  });
});
