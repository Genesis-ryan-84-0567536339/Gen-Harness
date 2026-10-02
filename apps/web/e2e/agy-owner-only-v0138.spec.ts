/**
 * v0.1.38 (F-22): model của Antigravity CLI chỉ dùng cho Gen — trợ lý quản trị (Gen của Sếp). Màn API & Model: dữ liệu
 * mẫu (bản cài cũ) gán agy cho "Sàng lọc & suy luận chính" → nhãn "Chỉ cho Gen" + câu việc cần làm hiện thẳng; gán agy
 * cho Sàng lọc → API trả 409 AGY_OWNER_GEN_ONLY → câu tiếng Việt (mã lỗi chỉ trong "Chi tiết kỹ thuật"); gán cho Gen →
 * lưu được; slot chưa gán mặc định chọn model KHÔNG phải agy.
 *
 * Luật nằm trong mock dùng chung (test/mock-p4-api.ts — slot `core.gen` với nhãn thật của máy chủ, `blocked_reason`
 * TRONG binding, 409 AGY_OWNER_GEN_ONLY), không chặn bằng page.route.
 *
 * F-17: tài khoản mạng xã hội chuyển máy mà phiên không mở được (needs_login + key_changed, has_session=false) → gợi ý
 * và nút đều là "Đăng nhập lại".
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { loginAsOwner, resetMock } from './support';

// Chuỗi THẬT của máy chủ: gh/providers/router.py::AGY_OWNER_ONLY_REASON = gh/agents_api/routes.py::AGY_GEN_ONLY_MSG.
const AGY_OWNER_ONLY_REASON =
  'Antigravity CLI chỉ dùng cho Gen — trợ lý quản trị (Gen của Sếp). Sàng lọc tin và trực việc phải dùng nguồn khác (khoá API hoặc Claude Code CLI) — luật an toàn, không tắt được.';

const GEN_LABEL = 'Gen — trợ lý quản trị';
const BLOCKED_HINT = 'Model này chỉ cho Gen — agent này bỏ qua nó. Chọn model khác hoặc bỏ gán.';

test.describe('v0.1.38 · Antigravity CLI chỉ dùng cho Gen của Sếp', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request as APIRequestContext, 'finished');
    await loginAsOwner(page);
  });

  test('gán model agy cho Sàng lọc → câu lỗi tiếng Việt; gán cho Gen → thành công', async ({ page }) => {
    const providers = (await (await page.request.get('/api/v1/providers')).json()) as Array<{ kind: string; models: Array<{ id: string; model_name: string }> }>;
    const agyModels = providers.filter((p) => p.kind === 'antigravity_cli').flatMap((p) => p.models);
    expect(agyModels.length).toBeGreaterThan(0);

    await page.goto('/api');
    const table = page.locator('.apm-table');
    await expect(table).toContainText('Sàng lọc & suy luận chính');
    await expect(table).toContainText(GEN_LABEL);

    // Thẻ Antigravity CLI nói rõ phạm vi (cùng một câu với API).
    await expect(page.getByTestId('cli-card-antigravity_cli')).toContainText('Chỉ dùng cho Gen — trợ lý quản trị (Gen của Sếp)');

    // Slot sàng lọc đang gán model agy (bản cài cũ) → "Chỉ cho Gen" + câu việc cần làm hiện thẳng (không chỉ tooltip).
    const refineryRow = table.locator('tr', { hasText: 'Sàng lọc & suy luận chính' });
    await expect(refineryRow.getByTestId('binding-blocked-core.refinery')).toContainText('Chỉ cho Gen');
    await expect(refineryRow.getByTestId('binding-blocked-core.refinery')).toHaveAttribute('title', AGY_OWNER_ONLY_REASON);
    await expect(refineryRow.getByTestId('binding-blocked-hint-core.refinery')).toHaveText(BLOCKED_HINT);

    // Slot chưa gán (Trả lời nhanh): ô chọn mặc định model không phải agy.
    const replyRow = table.locator('tr', { hasText: 'Trả lời nhanh trong nhóm' });
    await replyRow.locator('.apm-model-pill').click();
    let dlg = page.getByRole('dialog', { name: /Trả lời nhanh trong nhóm/ });
    await expect(dlg.locator('option', { hasText: 'chỉ cho Gen' }).first()).toBeAttached();
    const chosen = await dlg.getByLabel('Model').inputValue();
    expect(agyModels.some((m) => m.id === chosen)).toBe(false);
    await dlg.getByRole('button', { name: 'Huỷ' }).click();
    await expect(dlg).toBeHidden();

    // 1) Gán model agy cho Sàng lọc → 409 → câu tiếng Việt.
    await refineryRow.locator('.apm-model-pill').click();
    dlg = page.getByRole('dialog', { name: /Sàng lọc & suy luận chính/ });
    const agyOption = dlg.locator('option', { hasText: 'chỉ cho Gen' }).first();
    await expect(agyOption).toBeAttached();
    await dlg.getByLabel('Model').selectOption((await agyOption.getAttribute('value'))!);
    await expect(dlg.getByTestId('binding-agy-note')).toContainText('Chỉ dùng cho Gen — trợ lý quản trị (Gen của Sếp)');
    const put409 = page.waitForResponse((r) => r.url().includes('/agents/bindings/core.refinery') && r.request().method() === 'PUT');
    await dlg.getByRole('button', { name: 'Lưu' }).click();
    expect((await put409).status()).toBe(409);
    const alert = dlg.getByRole('alert');
    await expect(alert).toContainText(AGY_OWNER_ONLY_REASON);
    await expect(alert).not.toContainText('[object Object]');
    await expect(alert.locator('details.tech-detail summary')).toHaveText('Chi tiết kỹ thuật');
    // Mã lỗi chỉ nằm trong "Chi tiết kỹ thuật" (đóng sẵn → không hiển thị).
    await expect(alert.getByText(/AGY_OWNER_GEN_ONLY/)).toBeHidden();
    await alert.locator('details.tech-detail summary').click();
    await expect(alert.locator('details.tech-detail code')).toContainText('AGY_OWNER_GEN_ONLY');
    await dlg.getByRole('button', { name: 'Huỷ' }).click();
    await expect(dlg).toBeHidden();

    // 2) Gán model agy cho Gen → thành công, không có nhãn "Chỉ cho Gen".
    const genRow = table.locator('tr', { hasText: GEN_LABEL });
    await genRow.locator('.apm-model-pill').click();
    dlg = page.getByRole('dialog', { name: new RegExp(GEN_LABEL) });
    await expect(dlg.locator('option', { hasText: 'chỉ cho Gen' })).toHaveCount(0);
    await dlg.getByLabel('Model').selectOption(agyModels[0].id);
    const put200 = page.waitForResponse((r) => r.url().includes('/agents/bindings/core.gen') && r.request().method() === 'PUT');
    await dlg.getByRole('button', { name: 'Lưu' }).click();
    expect((await put200).status()).toBe(200);
    await expect(dlg).toBeHidden();
    await expect(genRow.locator('.apm-model-pill')).toContainText(agyModels[0].model_name);
    await expect(genRow.getByTestId('binding-blocked-core.gen')).toHaveCount(0);
  });

  test('F-17: tài khoản chuyển máy (key_changed, không còn phiên) → gợi ý và nút đều là "Đăng nhập lại"', async ({ page }) => {
    const res = await page.request.post('/api/v1/__mock/p3/social/importKeyChanged', { data: { label: 'Facebook chuyển máy' } });
    expect(res.ok()).toBe(true);
    await page.goto('/social');
    const row = page.locator('[data-testid^="social-account-"]', { hasText: 'Facebook chuyển máy' });
    await expect(row).toContainText('Cần đăng nhập lại');
    await expect(row).toContainText('Phiên đã lưu không mở được trên máy này (chuyển máy hoặc đổi khoá) — bấm Đăng nhập lại.');
    await expect(row.getByRole('button', { name: 'Đăng nhập lại' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Đăng nhập', exact: true })).toHaveCount(0);
  });
});
