/**
 * v0.1.42 — nghiệm thu menu mới trên máy chủ giả (tất định): một menu 6 mục + "Nâng cao" thu gọn, trang chủ theo vai
 * trò, Kết nối một trang (viên trạng thái chung), Đội ngũ, Cài đặt lọc tab theo quyền, link cũ chuyển đúng chỗ,
 * header gọn ngoài Nâng cao, logo hiện phiên bản thật, Hôm nay một hàng 4 số, dải tab không tràn ở 1440px.
 */
import { expect, test, type Page } from '@playwright/test';
import { MANAGER, loginAs, loginAsOwner, resetMock } from './support';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Danh mục màn hình' });
const LEVEL1 = ['Hôm nay', 'Hộp thư & Việc', 'Khách & Cơ hội', 'Kết nối', 'Đội ngũ', 'Cài đặt', 'Nâng cao'];

test.describe('v0.1.42 · menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request, 'finished');
  });

  test('1. Owner: "/" → /overview; đúng 7 mục cấp 1 (6 + Nâng cao)', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/overview$/);
    const items = nav(page).locator('[data-level1] .sb-item__name');
    await expect(items).toHaveText(LEVEL1);
    await expect(nav(page).getByText('Việc hằng ngày')).toBeVisible();
    await expect(nav(page).getByRole('link', { name: /Hôm nay/ })).toHaveAttribute('aria-current', 'page');
  });

  test('2. Nâng cao thu gọn mặc định, bấm thì mở; mở lại trang là thu gọn (không lưu)', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/overview');
    const adv = nav(page).getByRole('button', { name: /Nâng cao/ });
    await expect(adv).toHaveAttribute('aria-expanded', 'false');
    await expect(nav(page).getByText('Tầng dữ liệu')).toHaveCount(0);
    await adv.click();
    await expect(adv).toHaveAttribute('aria-expanded', 'true');
    await nav(page).getByRole('button', { name: /Tầng dữ liệu/ }).click();
    await expect(nav(page).getByRole('link', { name: /Kho dữ liệu thô/ })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: /Plugin & Tiện ích/ })).toHaveCount(0);
    await page.reload();
    await expect(nav(page).getByRole('button', { name: /Nâng cao/ })).toHaveAttribute('aria-expanded', 'false');
  });

  test('3. Màn Nâng cao: tự mở, header có tự trị + khiên + Góc nhìn đã lưu; ngoài Nâng cao thì không', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/raw');
    await expect(nav(page).getByRole('button', { name: /Nâng cao/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(nav(page).getByRole('link', { name: /Kho dữ liệu thô/ })).toHaveAttribute('aria-current', 'page');
    const hd = page.locator('header.hd');
    await expect(hd.getByText('tự trị 4')).toBeVisible();
    await expect(hd.getByRole('button', { name: 'Góc nhìn đã lưu' })).toBeVisible();
    await expect(page.locator('.hd-chip')).toHaveText('NÂNG CAO');
    await page.goto('/overview');
    await expect(hd.getByText(/\d+ kênh · \d+ nhóm/)).toBeVisible();
    await expect(hd.getByText('tự trị 4')).toHaveCount(0);
    await expect(hd.getByRole('button', { name: 'Góc nhìn đã lưu' })).toHaveCount(0);
    await expect(page.locator('.hd-chip')).toHaveText('HẰNG NGÀY');
  });

  test('4. Logo hiện phiên bản thật (GET /system/about), không còn "v2.2"', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/overview');
    await expect(page.locator('.sb-logo__sub')).toHaveText(/^Gen-Harness · v\d+\.\d+\.\d+/);
    await expect(page.locator('.sb-logo')).not.toContainText('v2.2');
  });

  test('5. Hôm nay: một hàng 4 số; Sức khoẻ hệ thống có 4 số kỹ thuật; nút "Mở hộp thư"', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/overview');
    await expect(page.locator('.ov-kpi-row')).toHaveCount(1);
    await expect(page.locator('.ov-kpi-row .ov-kpi')).toHaveCount(4);
    const health = page.locator('[data-gen-target="overview.health"]');
    await expect(health.getByTestId('ov-tech-row')).toHaveCount(4);
    await expect(health).not.toContainText('cách ly');
    await expect(page.getByRole('link', { name: 'Mở hộp thư', exact: true })).toHaveAttribute('href', '/inbox');
  });

  test('6. Kết nối: mỗi thẻ một viên trạng thái + một nút chính; Bộ não AI, kênh, Facebook, Gen-hub, MCP', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/connections');
    await expect(page.getByRole('heading', { level: 2, name: 'Kết nối' })).toBeVisible();
    const cards = [
      page.getByRole('region', { name: 'Bộ não AI', exact: true }),
      page.getByRole('article', { name: 'Kênh Zalo' }),
      page.getByRole('article', { name: 'Kênh WhatsApp' }),
      page.locator('[data-gen-target="system.channels.facebook"]'),
      page.locator('[data-gen-target="mcp.hub_link"]'),
      page.getByRole('region', { name: 'MCP', exact: true }),
    ];
    for (const c of cards) {
      await expect(c).toBeVisible();
      await expect(c.locator('[data-status]')).toHaveCount(1);
      await expect(c.locator('[data-main-action]')).toHaveCount(1);
    }
    await expect(page.locator('a[href="/plugins"]')).toHaveCount(0);
    // Thẻ tài khoản CLI chỉ ở đây (mục #brain).
    await expect(page.locator('#brain [data-testid="cli-card-antigravity_cli"]')).toBeVisible();
    await page.getByRole('region', { name: 'Bộ não AI', exact: true }).getByRole('link', { name: /Mở Bộ não AI/ }).click();
    await expect(page).toHaveURL(/\/system\?tab=brain$/);
    await expect(page.getByRole('tab', { name: /Bộ não AI/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('7. Link cũ: ?tab=channels → /connections, ?tab=users → /team, ?tab=storage&focus=… giữ nguyên', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/system?tab=channels');
    await expect(page).toHaveURL(/\/connections$/);
    await page.goto('/system?tab=users');
    await expect(page).toHaveURL(/\/team$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Đội ngũ' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Mời người dùng/ })).toBeVisible();
    await page.goto('/system?tab=storage&focus=health');
    await expect(page).toHaveURL(/\/system\?tab=storage&focus=health$/);
    await expect(page.getByRole('tab', { name: /Sao lưu & cập nhật/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('8. Cài đặt (Owner): 5 tab theo thứ tự, dải tab không tràn và không cắt chữ ở 1440px', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/system');
    const tabs = page.getByRole('tablist', { name: 'Cài đặt' }).getByRole('tab');
    await expect(tabs).toHaveCount(5);
    await expect(tabs.first()).toContainText('Sao lưu & cập nhật');
    await expect(tabs.last()).toContainText('Nhật ký');
    const m = await page.getByRole('tablist', { name: 'Cài đặt' }).evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
      cut: Array.from(el.querySelectorAll<HTMLElement>('[role="tab"]')).some((t) => t.scrollWidth > t.clientWidth + 1),
    }));
    expect(m.scroll).toBeLessThanOrEqual(m.client);
    expect(m.cut).toBe(false);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByRole('link', { name: /Tài khoản & PIN của tôi/ })).toHaveAttribute('href', '/account');
    await expect(page.getByRole('link', { name: /Hướng dẫn thiết lập/ })).toHaveAttribute('href', '/guide');
  });

  test('9. Quản lý: "/" về màn đầu tiên của vai trò; Cài đặt chỉ có tab Nhật ký; không có Kết nối/Đội ngũ', async ({ page }) => {
    await loginAs(page, MANAGER.email);
    await page.goto('/');
    await expect(page).toHaveURL(/\/overview$/);
    await expect(nav(page).getByRole('link', { name: /Kết nối/ })).toHaveCount(0);
    await expect(nav(page).getByRole('link', { name: /Đội ngũ/ })).toHaveCount(0);
    await page.goto('/system');
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toContainText('Nhật ký');
    await expect(page.getByRole('link', { name: /Hướng dẫn thiết lập/ })).toHaveCount(0);
  });

  test('10. Chưa có nhân viên: Đội ngũ không có Đánh giá/Chăm sóc trên thanh bên, có ghi chú', async ({ page }) => {
    await resetMock(page.request, 'finished', { staff: false });
    await loginAsOwner(page);
    await page.goto('/team');
    await expect(nav(page).getByRole('link', { name: /Đội ngũ/ })).toHaveAttribute('aria-current', 'page');
    await expect(nav(page).getByText('Đánh giá con người')).toHaveCount(0);
    await expect(nav(page).getByText('Chất lượng chăm sóc')).toHaveCount(0);
    await expect(page.getByText('Đánh giá và Chăm sóc hiện khi đã có ít nhất 1 nhân viên.', { exact: true }).last()).toBeVisible();
    // Màn vẫn có route.
    await page.goto('/people');
    await expect(page.locator('.content')).not.toBeEmpty();
  });

  test('11. Màn ẩn vẫn mở được (/profile, /plugins); /social, /help, /guide tô sáng mục cha', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/plugins');
    await expect(page.getByRole('heading', { level: 2, name: 'Plugin & Tiện ích' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: /Plugin & Tiện ích/ })).toHaveCount(0);
    await page.goto('/profile?id=p-bao');
    await expect(page.locator('.content')).not.toBeEmpty();
    await expect(nav(page).getByRole('link', { name: /Hồ sơ sống/ })).toHaveCount(0);
    await page.goto('/social');
    await expect(nav(page).getByRole('link', { name: /Kết nối/ })).toHaveAttribute('aria-current', 'page');
    await page.goto('/help');
    await expect(nav(page).getByRole('link', { name: /Cài đặt/ })).toHaveAttribute('aria-current', 'page');
    await page.goto('/guide');
    await expect(page.locator('.hd-title')).toHaveText('Hướng dẫn thiết lập');
    await expect(nav(page).getByRole('link', { name: /Cài đặt/ })).toHaveAttribute('aria-current', 'page');
  });
});
