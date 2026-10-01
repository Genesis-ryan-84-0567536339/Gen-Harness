import { expect, test } from '@playwright/test';
import { loginAsOwner, resetMock } from './support';

/**
 * v0.1.34 (F-10, F-11, F-33) — genh cập nhật an toàn: bản mới lỗi ⇒ genh tự quay về bản cũ, ghi run/update-blocked.json
 * và báo "failed" vào hộp thư; lịch đêm sau đó KHÔNG tự thử lại bản đó (GH-E949) nhưng "Thử lại"/"Cập nhật ngay" vẫn chạy.
 * Mock trả đúng khuôn `GET /system/update` mà api đọc từ hộp thư genh, kiểm Console hiện thẻ thân thiện + nút Thử lại.
 */
const BLOCKED_MSG =
  'Bản v0.1.34 đã lỗi ở lần cập nhật trước và đã tự quay về bản cũ — lịch đêm không tự thử lại bản này. Bấm "Cập nhật ngay" để thử lại. (GH-E949)';

function updateState(over: Record<string, unknown> = {}) {
  return {
    current: 'v0.1.33',
    latest: 'v0.1.34',
    update_available: true,
    updater: 'systemd',
    linked: true,
    can_request: true,
    state: 'failed',
    message: BLOCKED_MSG,
    from: 'v0.1.33',
    to: 'v0.1.34',
    started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    finished_at: new Date(Date.now() - 60_000).toISOString(),
    requested_at: null,
    release_url: null,
    release_notes: null,
    published_at: null,
    auto_update_enabled: true,
    ...over,
  };
}

test.describe('v0.1.34 — cập nhật lỗi tự quay về bản cũ', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request, 'finished');
    await loginAsOwner(page);
  });

  test('thẻ "chưa thành công" báo đã quay về bản cũ, hiện thông điệp genh, "Thử lại" gửi yêu cầu cập nhật', async ({ page }) => {
    let posts = 0;
    let state = updateState();
    await page.route('**/api/v1/system/update', async (route) => {
      const method = route.request().method();
      if (method === 'POST') {
        posts += 1;
        state = updateState({ state: 'requested', message: null, requested_at: new Date().toISOString(), finished_at: null });
        return route.fulfill({ json: state });
      }
      if (method === 'GET') return route.fulfill({ json: state });
      return route.fallback();
    });
    await page.goto('/help');
    await expect(page.getByText('Cập nhật lên v0.1.34 chưa thành công')).toBeVisible();
    await expect(page.getByText('Hệ thống đã tự quay về bản đang dùng — dữ liệu giữ nguyên')).toBeVisible();
    await expect(page.getByText(/lịch đêm không tự thử lại bản này/)).toBeVisible();
    // Không màn hình lỗi chung, không render đối tượng thô.
    await expect(page.getByText('Đã có lỗi xảy ra')).toHaveCount(0);
    await expect(page.getByText('[object Object]')).toHaveCount(0);
    await page.getByRole('button', { name: /Thử lại/ }).click();
    await expect.poll(() => posts).toBe(1);
    await expect(page.getByText(/Đang cập nhật lên v0.1.34/)).toBeVisible();
  });

  test('lỗi đã cũ không treo thẻ đỏ mãi — quay về "Có bản mới" với "Cập nhật ngay"', async ({ page }) => {
    const old = updateState({ finished_at: '2020-01-01T00:00:00Z', started_at: '2020-01-01T00:00:00Z' });
    await page.route('**/api/v1/system/update', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: old }) : route.fallback(),
    );
    await page.goto('/help');
    await expect(page.getByText('Có bản mới v0.1.34')).toBeVisible();
    await expect(page.getByText(/chưa thành công/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Cập nhật ngay/ })).toBeVisible();
  });
});
