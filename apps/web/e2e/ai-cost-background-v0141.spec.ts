import { expect, test } from '@playwright/test';
import { loginAsOwner, p3Hook, resetMock } from './support';

/**
 * v0.1.41 (F-84, F-86): Chi phí AI hôm nay ở Tổng quan › Sức khoẻ (focus=ai-cost), Bộ não AI › "Nguồn AI cho việc nền"
 * (bật Claude Code CLI: cảnh báo + tích + PIN) và mẫu nhà cung cấp OpenRouter. Mock tính sẵn 12.500 ₫ hôm nay.
 */
test.describe('v0.1.41 — Chi phí AI & nguồn AI cho việc nền', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request, 'finished');
  });

  test('Tổng quan có "Chi phí AI hôm nay" với số ₫; ?focus=ai-cost cuộn tới thẻ', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/overview');
    const panel = page.getByRole('region', { name: 'Chi phí AI hôm nay' });
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('ai-cost-total')).toHaveText('12.500 ₫');
    await expect(panel).toContainText('12.500 ₫ / trần 20.000 ₫');
    await expect(panel).toContainText('3 lượt gọi chưa có giá — nhập giá ở Bộ não AI');
    await expect(panel).toContainText('Hữu ích 7 ngày: 14/17');
    // Ngay sau "Sức khoẻ hệ thống" trong lưới dưới.
    const order = await page.locator('.ov-bottom-grid section[aria-label], .ov-bottom-grid > section').evaluateAll((els) =>
      els.map((e) => e.getAttribute('aria-label') ?? e.querySelector('.gh-card__title')?.textContent ?? ''),
    );
    expect(order.indexOf('Chi phí AI hôm nay')).toBe(order.indexOf('Sức khoẻ hệ thống') + 1);

    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto('/overview?focus=ai-cost');
    const box = page.locator('#ai-cost');
    await expect(box).toBeFocused();
    await expect(box).toBeInViewport();
    await expect(page.getByText('[object Object]')).toHaveCount(0);
  });

  test('Bộ não AI: bật Claude Code CLI cho việc nền ⇒ cảnh báo + tích + PIN ⇒ lưu', async ({ page }) => {
    await loginAsOwner(page);
    await p3Hook(page.request, 'api', 'background', { claude: true });
    await page.goto('/system?tab=brain');
    const card = page.getByRole('region', { name: 'Nguồn AI cho việc nền' });
    await expect(card).toContainText('Dùng cho sàng lọc tin, trực việc, Bản tin Gen');
    await expect(card.getByText('Dùng cho việc nền').first()).toBeVisible();
    const sw = card.getByRole('switch', { name: 'Cho Claude Code CLI chạy việc nền' });
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await sw.click();
    const dlg = page.getByRole('dialog', { name: 'Cho Claude Code CLI chạy việc nền' });
    await expect(dlg.getByTestId('bg-cli-risk')).toContainText('Sếp tự chịu rủi ro');
    const allow = dlg.getByRole('button', { name: 'Cho phép' });
    await expect(allow).toBeDisabled();
    await dlg.getByRole('checkbox', { name: 'Tôi đã đọc cảnh báo và tự chịu rủi ro' }).check();
    await allow.click();
    const pin = page.getByRole('dialog', { name: 'Mã PIN xác nhận thao tác' });
    await expect(pin).toBeVisible();
    await page.getByLabel('Mã PIN — chữ số 1/6').click();
    await page.keyboard.type('246810');
    await expect(pin).toBeHidden();
    await expect(dlg).toBeHidden();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    // Tắt lại không cần cảnh báo.
    await sw.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(sw).toHaveAttribute('aria-checked', 'false');

    // Thẻ chi phí cùng tab: CLI trả theo gói, không sửa.
    const budget = page.getByRole('region', { name: 'Chi phí & trần ngân sách' });
    await expect(budget.getByTestId('ai-price-mc-claude-cli')).toContainText('Trả theo gói — 0 ₫');
    await expect(page.getByText('[object Object]')).toHaveCount(0);
  });

  test('API & Model: thêm nhà cung cấp từ mẫu OpenRouter', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/api');
    await page.getByRole('button', { name: /Thêm nhà cung cấp/ }).first().click();
    const dlg = page.getByRole('dialog', { name: 'Thêm nhà cung cấp' });
    await dlg.getByLabel('Loại').selectOption('openrouter');
    await expect(dlg.getByLabel('Tên hiển thị')).toHaveValue('OpenRouter');
    await expect(dlg.getByLabel('Địa chỉ gọi (Endpoint)')).toHaveValue('https://openrouter.ai/api/v1');
    await expect(dlg).toContainText('Tạo khoá ở openrouter.ai › Keys rồi dán vào đây');
    await dlg.getByLabel('Khoá API (mỗi dòng một khoá)').fill('sk-mock-or-0001');
    await dlg.getByRole('button', { name: 'Thêm' }).click();
    const pin = page.getByRole('dialog', { name: 'Mã PIN xác nhận thao tác' });
    await Promise.race([pin.waitFor({ state: 'visible' }), dlg.waitFor({ state: 'hidden' })]);
    if (await pin.isVisible()) {
      await page.getByLabel('Mã PIN — chữ số 1/6').click();
      await page.keyboard.type('246810');
    }
    await expect(dlg).toBeHidden();
    await expect(page.getByText('OpenRouter', { exact: true }).first()).toBeVisible();
  });
});
