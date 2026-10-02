import { expect, test } from '@playwright/test';
import { loginAsOwner, mockHook, resetMock } from './support';

/**
 * v0.1.36 (F-6, F-2, F-46) — Sếp thấy ngay việc cần tự tay làm: dải "Cần Sếp xử lý" đầu Tổng quan (sự cố từ
 * `GET /system/health`), thẻ "Sức khoẻ hệ thống" ở Điều khiển hệ thống › Dữ liệu & lưu trữ, chuông có kind sự cố mới,
 * "Hạn lưu dữ liệu" nói rõ chưa tự xoá, Trợ giúp hiện phiên bản ảnh.
 */
test.describe('v0.1.36 — Cần Sếp xử lý & Sức khoẻ hệ thống', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request, 'finished');
    await loginAsOwner(page);
  });

  test('sự cố kênh rớt + cập nhật lỗi ⇒ dải 2 dòng; "Đăng nhập lại" mở tab Kênh', async ({ page }) => {
    await mockHook(page.request, 'health', { issues: [{ kind: 'channel.down', title: 'Kênh Zalo đã ngắt kết nối' }, { kind: 'update.failed' }] });
    await page.goto('/overview');
    const strip = page.getByRole('region', { name: 'Cần Sếp xử lý' });
    await expect(strip).toBeVisible();
    await expect(strip.getByRole('heading', { name: 'Cần Sếp xử lý' })).toBeVisible();
    const rows = strip.getByTestId('needs-boss-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Kênh Zalo đã ngắt kết nối');
    await expect(rows.nth(1)).toContainText('Lần cập nhật gần nhất lỗi');
    await expect(page.getByText('[object Object]')).toHaveCount(0);
    await strip.getByRole('link', { name: 'Đăng nhập lại' }).click();
    await expect(page).toHaveURL(/\/system\?tab=channels$/);
  });

  test('mặc định (khoẻ, đã có model) ⇒ Tổng quan không có dải', async ({ page }) => {
    await page.goto('/overview');
    await expect(page.locator('[data-gen-target="overview.kpis"]')).toBeVisible();
    await expect(page.getByTestId('needs-boss')).toHaveCount(0);
  });

  test('thẻ "Sức khoẻ hệ thống": đang chạy; Bộ xử lý nền im 14 phút ⇒ "Im 14 phút" + dòng trong dải Tổng quan', async ({ page }) => {
    await page.goto('/system?tab=storage');
    const card = page.getByRole('region', { name: 'Sức khoẻ hệ thống' });
    await expect(card).toBeVisible();
    await expect(card.getByTestId('health-worker')).toContainText('Đang chạy');
    await expect(card.getByTestId('health-backup')).toContainText('Bản mới nhất');
    await card.getByText('Chi tiết kỹ thuật').click();
    await expect(card.getByText('backup_scheduled')).toBeVisible();
    await expect(card.getByText('gh:raw.dlq')).toBeVisible();

    await mockHook(page.request, 'health', { worker: { state: 'silent', alive: false, silent_minutes: 14, last_seen_at: new Date(Date.now() - 14 * 60_000).toISOString() } });
    await page.reload();
    await expect(page.getByRole('region', { name: 'Sức khoẻ hệ thống' }).getByTestId('health-worker')).toHaveText(/Im 14 phút/);
    await page.goto('/overview');
    const strip = page.getByRole('region', { name: 'Cần Sếp xử lý' });
    await expect(strip.getByTestId('needs-boss-row')).toHaveCount(1);
    await expect(strip).toContainText('Bộ xử lý nền đã ngừng');
    await expect(strip.getByRole('link', { name: 'Xem sức khoẻ' })).toHaveAttribute('href', '/system?tab=storage');
  });

  test('Hạn lưu dữ liệu: "Chưa tự xoá — sẽ áp dụng ở bản sau", nút Sửa bị khoá', async ({ page }) => {
    await page.goto('/system?tab=storage');
    const panel = page.getByRole('region', { name: 'Hạn lưu dữ liệu' });
    await expect(panel.getByText('Chưa tự xoá — sẽ áp dụng ở bản sau')).toBeVisible();
    await expect(panel.getByRole('note')).toContainText('Hệ thống CHƯA tự xoá dữ liệu theo các hạn này');
    const edits = panel.getByRole('button', { name: 'Sửa' });
    await expect(edits.first()).toBeDisabled();
    expect(await edits.count()).toBeGreaterThan(0);
    for (const b of await edits.all()) await expect(b).toBeDisabled();
  });

  test('chuông: kind channel.down mới ⇒ tăng 1, dải tự hiện không cần tải lại, bấm mở tab Kênh', async ({ page }) => {
    await page.goto('/overview');
    const bell = page.locator('header .hd-bell');
    await expect(bell).toHaveAccessibleName('Thông báo — 1 chưa đọc');
    await expect(page.locator('[data-gen-target="overview.kpis"]')).toBeVisible();
    await expect(page.getByTestId('needs-boss')).toHaveCount(0);
    // API thật: health.raise_once mở dòng ops.health_alerts rồi gửi chuông — mock: ghi đè sức khoẻ trước, rồi chuông.
    await mockHook(page.request, 'health', { issues: [{ kind: 'channel.down' }] });
    await mockHook(page.request, 'notify', { kind: 'channel.down', title: 'Kênh Zalo đã ngắt kết nối', body: 'Đăng nhập lại để nhận tin.', link: '/system?tab=channels' });
    await expect(bell).toHaveAccessibleName('Thông báo — 2 chưa đọc');
    // notification.new kind sự cố ⇒ làm mới /system/health ngay (không chờ 60 giây).
    await expect(page.getByRole('region', { name: 'Cần Sếp xử lý' })).toContainText('Kênh Zalo đã ngắt kết nối');
    await bell.click();
    const dlg = page.getByRole('dialog', { name: 'Thông báo' });
    await expect(dlg.locator('.nt-item').first()).toContainText('Kênh Zalo đã ngắt kết nối');
    await expect(dlg.locator('.nt-item').first().locator('[data-icon]').first()).toHaveAttribute('data-icon', /plugs/);
    await dlg.getByRole('button', { name: /Kênh Zalo đã ngắt kết nối/ }).click();
    await expect(page).toHaveURL(/\/system\?tab=channels$/);
  });

  test('Trợ giúp hiện phiên bản ảnh và genh', async ({ page }) => {
    await page.goto('/help');
    const about = page.locator('[data-gen-target="help.version"]');
    await expect(about.getByText('Phiên bản ảnh')).toBeVisible();
    await expect(about.getByTestId('about-image-version')).toHaveText(/^v\d+\.\d+\.\d+/);
    await expect(about.getByText('genh', { exact: true })).toBeVisible();
  });
});
