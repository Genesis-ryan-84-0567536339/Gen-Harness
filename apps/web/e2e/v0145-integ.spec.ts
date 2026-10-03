import { expect, test, type Page } from '@playwright/test';
import { OWNER, loginAsOwner, resetMock } from './support';

/**
 * v0.1.45 — nghiệm thu sau khi gộp 4 gói (pin-rbac-cli, mcp-ssrf-log, run-pg-secrets, ws-people-help), phần mock:
 * (d) MCP đổi tool ghi → đọc hỏi PIN; (e) dòng đánh giá nhân sự bị gắn cờ có chip 'Đáng ngờ' + lý do khi rê chuột;
 * (f) Trợ giúp có đoạn 'Mã PIN bảo vệ được gì'. Không chỗ nào hiện lỗi 423 thô hay '[object Object]'.
 * (a)–(c) nằm ở pin-barriers-v0145.spec.ts.
 */

const PIN_DIALOG = 'Mã PIN xác nhận thao tác';

async function enterOwnerPin(page: Page): Promise<void> {
  const dlg = page.getByRole('dialog', { name: PIN_DIALOG });
  await expect(dlg).toBeVisible();
  await page.getByLabel('Mã PIN — chữ số 1/6').click();
  await page.keyboard.type(OWNER.pin);
  await expect(dlg).toBeHidden();
}

async function expectNoRawError(page: Page): Promise<void> {
  await expect(page.getByText('[object Object]')).toHaveCount(0);
  await expect(page.getByText(/\b423\b/)).toHaveCount(0);
  await expect(page.getByText(/PIN_REQUIRED/)).toHaveCount(0);
}

test.describe('v0.1.45 — nghiệm thu sau gộp (mock)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request, 'finished');
    await loginAsOwner(page);
  });

  test('(d) MCP: đổi tool ghi → đọc hỏi PIN rồi lưu; đọc → ghi không hỏi', async ({ page }) => {
    await page.goto('/mcp');
    await expect(page.getByRole('heading', { name: 'MCP Hub', level: 2 })).toBeVisible();
    const crm = page.locator('.mcp-server', { hasText: 'CRM Genesis' });
    const sel = crm.getByLabel('Loại tool deal.upsert');
    await expect(sel).toHaveValue('write');
    await expect(crm.getByText('Chuyển tool ghi sang đọc cần mã PIN').first()).toBeVisible();

    const ok = page.waitForResponse((r) => r.url().includes('/mcp/tools/') && r.request().method() === 'PATCH' && r.status() === 200);
    await sel.selectOption('read');
    await enterOwnerPin(page);
    await ok;
    await expect(sel).toHaveValue('read');
    await expectNoRawError(page);

    // Đọc → ghi (chặt hơn): không hỏi PIN.
    const erp = page.locator('.mcp-server', { hasText: 'ERP Genesis' });
    const sel2 = erp.getByLabel('Loại tool order.lookup');
    const ok2 = page.waitForResponse((r) => r.url().includes('/mcp/tools/') && r.request().method() === 'PATCH');
    await sel2.selectOption('write');
    expect((await ok2).status()).toBe(200);
    await expect(sel2).toHaveValue('write');
    await expect(page.getByRole('dialog', { name: PIN_DIALOG })).toHaveCount(0);
  });

  test("(e) Đánh giá nhân sự: dòng bị gắn cờ có chip 'Đáng ngờ' với lý do khi rê chuột", async ({ page }) => {
    await page.goto('/people');
    await enterOwnerPin(page);
    await expect(page.getByRole('heading', { name: 'Đánh giá con người', level: 2 })).toBeVisible();
    const tu = page.locator('.ppl-row', { hasText: 'Phạm Anh Tú' });
    const chip = tu.getByTestId('ppl-suspicious');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('Đáng ngờ');
    await expect(chip).toHaveAttribute('title', /xin điểm/);
    await chip.hover();
    // Chỉ dòng bị gắn cờ mới có chip.
    await expect(page.getByTestId('ppl-suspicious')).toHaveCount(1);
    await expectNoRawError(page);
  });

  test("(f) Trợ giúp có đoạn 'Mã PIN bảo vệ được gì'", async ({ page }) => {
    await page.goto('/help');
    const card = page.getByTestId('help-pin-limits');
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Mã PIN bảo vệ được gì' })).toBeVisible();
    await expect(card.getByText(/KHÔNG phải lớp bảo vệ thứ hai/)).toBeVisible();
    await expectNoRawError(page);
  });
});
