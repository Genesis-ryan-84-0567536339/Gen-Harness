import { expect, test, type Page } from '@playwright/test';
import { OWNER, apiCall, loginAsOwner, resetMock } from './support';

/**
 * v0.1.43 (F-24): nháp tin của Gen chỉ được LƯU — thẻ nói rõ "Đã lưu nháp — chưa gửi" và nút "Duyệt & gửi" mở
 * đúng nháp đó ở Bàn làm việc (/workbench?id=<id>), nơi có sẵn luồng duyệt/gửi. Không có đường gửi mới.
 */

async function enterPin(page: Page) {
  const dlg = page.getByRole('dialog', { name: 'Mã PIN xác nhận thao tác' });
  await expect(dlg).toBeVisible();
  await page.getByLabel('Mã PIN — chữ số 1/6').click();
  await page.keyboard.type(OWNER.pin);
  await expect(dlg).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await resetMock(page.request, 'finished');
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsOwner(page);
  await page.goto('/overview');
});

test('Gen soạn nháp tin → Xác nhận → "Đã lưu nháp — chưa gửi" → "Duyệt & gửi" mở đúng nháp ở Bàn làm việc', async ({ page }) => {
  const panel = page.getByRole('complementary', { name: /Gen — trợ lý quản trị/ });
  await page.getByRole('button', { name: /Hỏi Gen/ }).click();
  await expect(panel).toBeVisible();
  await panel.getByLabel('Câu hỏi cho Gen').fill('soạn nháp tin báo giá cho anh Bảo');
  await panel.getByRole('button', { name: 'Gửi' }).click();

  const card = panel.getByRole('group', { name: 'Đề xuất: Soạn nháp tin gửi đi' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Báo giá ván MDF');
  await card.getByRole('button', { name: 'Xác nhận' }).click();
  await enterPin(page);

  await expect(card).toContainText('Đã lưu nháp — chưa gửi · ACT-0999');
  await expect(card).not.toContainText('Đã xác nhận');
  await expect(card.locator('[data-icon="paper-plane-tilt"]')).toHaveCount(0);
  const go = card.getByRole('button', { name: 'Duyệt & gửi' });
  await expect(go).toBeVisible();
  await go.click();

  await expect(page).toHaveURL(/\/workbench\?id=draft-gen-[0-9a-f-]+$/);
  const id = decodeURIComponent(new URL(page.url()).searchParams.get('id') ?? '');
  expect(id).toMatch(/^draft-gen-/);

  // Dòng nháp được chọn đúng tiêu đề; khung chi tiết hiện đúng nháp đó với nút duyệt/gửi sẵn có.
  const row = page.locator('.wb-list__row[aria-pressed="true"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Báo giá ván MDF');
  const detail = page.locator('.wb-grid');
  await expect(detail.getByText('Chào anh Bảo, bên em gửi báo giá ván MDF E1 17mm như anh hỏi ạ.')).toBeVisible();
  await expect(detail.getByRole('button', { name: /Duyệt và gửi qua Zalo/ })).toBeVisible();
  // Chỉ điều hướng — nháp vẫn chờ duyệt.
  const saved = (await apiCall(page, 'GET', `/drafts/${encodeURIComponent(id)}`)) as { status: string; title: string };
  expect(saved).toMatchObject({ status: 'pending', title: 'Báo giá ván MDF' });
});
