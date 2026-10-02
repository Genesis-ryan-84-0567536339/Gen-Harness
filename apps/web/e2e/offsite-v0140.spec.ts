import { expect, test } from '@playwright/test';
import { loginAsOwner, p3Hook, resetMock } from './support';

/**
 * v0.1.40 (F-12) — Bản sao ngoài máy (ổ USB/NAS cắm vào máy chủ): sự cố `offsite.stale` ở dải "Cần Sếp xử lý" dẫn tới
 * đúng thẻ (focus=offsite); Owner chọn nơi lưu (PIN) ⇒ chờ máy chủ nhận; Bộ khôi phục hiện khoá + mã QR vẽ tại chỗ.
 */
test.describe('v0.1.40 — Bản sao ngoài máy', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request, 'finished');
  });

  test('dải "Cần Sếp xử lý" có dòng offsite.stale ⇒ bấm hành động tới thẻ Bản sao ngoài máy (được focus, cảnh báo vàng)', async ({ page }) => {
    await loginAsOwner(page);
    // Lần thành công gần nhất 9 ngày trước ⇒ API (mock) mở sự cố offsite.stale (warn) + khối offsite trong /system/health.
    await p3Hook(page.request, 'system', 'offsite', { days_ago: 9 });
    await page.goto('/overview');
    const strip = page.getByRole('region', { name: 'Cần Sếp xử lý' });
    // Chữ của API thật (gh/health._eval_offsite / ACTIONS) — mock chép đúng.
    const row = strip.getByTestId('needs-boss-row').filter({ hasText: 'Bản sao ngoài máy đã cũ 9 ngày' });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-severity', 'warn');
    await row.getByRole('link', { name: 'Chọn nơi lưu / sao lưu ngay' }).click();
    await expect(page).toHaveURL(/\/system\?tab=storage&focus=offsite$/);

    const card = page.getByRole('region', { name: 'Bản sao ngoài máy' });
    await expect(card).toBeVisible();
    await expect(card).toBeFocused();
    await expect(card).toBeInViewport();
    await expect(card.getByTestId('offsite-latest')).toContainText('(9 ngày trước)');
    await expect(card.getByTestId('offsite-warning')).toHaveAttribute('data-tone', 'warn');
    await expect(card.getByTestId('offsite-warning')).toContainText('Hỏng ổ đĩa là mất hết dữ liệu');
    // Thẻ Bản sao ngoài máy đứng ngay sau Sao lưu & khôi phục.
    const order = await page.locator('section[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(order.indexOf('Bản sao ngoài máy')).toBe(order.indexOf('Sao lưu & khôi phục') + 1);
    // Thẻ Sức khoẻ có dòng Bản sao ngoài máy (vàng).
    await expect(page.getByRole('region', { name: 'Sức khoẻ hệ thống' }).getByTestId('health-offsite')).toHaveAttribute('data-tone', 'warn');
    await expect(page.getByText('[object Object]')).toHaveCount(0);
  });

  test('Owner chọn nơi lưu (PIN) ⇒ "Đang chờ máy chủ nhận…"; Bộ khôi phục hiện khoá + mã QR', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/system?tab=storage');
    const card = page.getByRole('region', { name: 'Bản sao ngoài máy' });
    await expect(card.getByTestId('offsite-latest')).toContainText('Bản sao ngoài máy gần nhất:');
    await expect(card.getByText('Mỗi Chủ nhật ~05:30')).toBeVisible();

    await card.getByRole('button', { name: 'Chọn nơi lưu bản sao ngoài máy' }).click();
    const dlg = page.getByRole('dialog', { name: 'Chọn nơi lưu bản sao ngoài máy' });
    await expect(dlg).toContainText('/media/<tên>/<ổ>');
    await dlg.getByLabel('Đường dẫn ổ USB/NAS trên máy chủ').fill('/media/sep/USB-MOI');
    await dlg.getByRole('button', { name: 'Lưu' }).click();
    const pin = page.getByRole('dialog', { name: 'Mã PIN xác nhận thao tác' });
    await expect(pin).toBeVisible();
    await page.getByLabel('Mã PIN — chữ số 1/6').click();
    await page.keyboard.type('246810');
    await expect(pin).toBeHidden();
    await expect(dlg).toBeHidden();
    await expect(card.getByTestId('offsite-request')).toContainText('Đang chờ máy chủ nhận yêu cầu đổi nơi lưu…');

    // Phiên PIN còn hiệu lực ⇒ Bộ khôi phục mở thẳng.
    await card.getByRole('button', { name: 'Bộ khôi phục' }).click();
    const kit = page.getByRole('dialog', { name: 'Bộ khôi phục' });
    await expect(kit.getByTestId('recovery-key')).toHaveText(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){5}$/);
    await expect(kit.getByRole('img', { name: 'Mã QR của Khoá khôi phục' })).toBeVisible();
    await expect(kit).toContainText('Cất TÁCH khỏi ổ USB');
    await expect(kit).toContainText('genh import --yes <tệp .ghbundle>');
    await kit.getByRole('button', { name: 'Đã cất xong' }).click();
    await expect(kit).toBeHidden();
    await expect(page.getByTestId('recovery-key')).toHaveCount(0);
    await expect(page.getByText('[object Object]')).toHaveCount(0);
  });
});
