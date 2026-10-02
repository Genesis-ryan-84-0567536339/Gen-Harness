/**
 * v0.1.39 (F-32): trang Tài khoản mạng xã hội có lối vào cố định — mục "Mạng xã hội" trên thanh bên (chỉ Owner, ngay
 * dưới Hướng dẫn thiết lập) và thẻ Facebook ở Hệ thống › Kênh. Vai trò khác (Vận hành) không thấy mục này.
 */
import { expect, test } from '@playwright/test';
import { loginAs, loginAsOwner, resetMock } from './support';

test.describe('v0.1.39 · lối vào trang Tài khoản mạng xã hội', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request, 'finished');
  });

  test('Owner: mục "Mạng xã hội" trên thanh bên mở /social', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/overview');
    const nav = page.getByRole('navigation', { name: 'Danh mục màn hình' });
    const item = nav.getByRole('link', { name: /Mạng xã hội/ });
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('href', '/social');
    await item.click();
    await expect(page).toHaveURL(/\/social$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Tài khoản mạng xã hội' })).toBeVisible();
    await expect(item).toHaveAttribute('aria-current', 'page');
  });

  test('Owner: Hệ thống › Kênh có thẻ Facebook dẫn tới /social', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/system?tab=channels');
    const card = page.locator('[data-gen-target="system.channels.facebook"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Đọc thông báo và tin nhắn — đăng nhập ngay trong app');
    await card.getByRole('link', { name: 'Mở trang Tài khoản mạng xã hội' }).click();
    await expect(page).toHaveURL(/\/social$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Tài khoản mạng xã hội' })).toBeVisible();
  });

  test('Vận hành: không có mục "Mạng xã hội" trên thanh bên', async ({ page }) => {
    await loginAs(page, 'operator@genesis.local');
    await page.goto('/overview');
    const nav = page.getByRole('navigation', { name: 'Danh mục màn hình' });
    await expect(nav.locator('.sb-group').first()).toBeVisible();
    await expect(nav.getByRole('link', { name: /Mạng xã hội/ })).toHaveCount(0);
    await expect(page.locator('[data-screen="social"]')).toHaveCount(0);
  });
});
