import { expect, test } from '@playwright/test';
import { askGen, enterPin, enterPinIfAsked, hubSim, khoCalls, loginAsOwner, p3Hook, resetMock } from './support';

/**
 * v0.1.50 (F-81, QD-18) — mock, tất định (KHÔNG có Kho / Gen-hub thật): Gen đề xuất ghi Kho Ryan → thẻ "Ghi vào Kho Ryan" hiện đúng bảng +
 * trường → Xác nhận và ghi Kho → 423 → nhập mã PIN → "Đã ghi vào Kho: PHIEN-12". Bấm Huỷ thì mock ghi nhận 0 lời gọi /hub/kho/write.
 * Thiếu quyền ghi Kho → khoá nút + nút mở thẻ Gen-hub; lỗi "Chưa chắc đã ghi" → câu đúng, bấm lại được; dòng 9 "Gen ghi Kho" đạt sau lần ghi đầu.
 */

const CARD = 'Ghi vào Kho Ryan';
const WARNING = 'Ghi thẳng vào Kho Ryan qua Gen-hub khi Sếp bấm Xác nhận và nhập mã PIN — không tự hoàn tác.';

test.beforeEach(async ({ page }) => {
  await resetMock(page.request, 'finished');
  await page.setViewportSize({ width: 1440, height: 900 });
  await hubSim(page.request, { link: 'on', write: 'ok', kho: 'ok' }); // Gen-hub đã nối + Kiểm tra xanh, token có quyền ghi Kho
  await loginAsOwner(page);
});

test('Gen đề xuất ghi Phiên → thẻ đúng bảng + trường → Xác nhận → 423 → nhập PIN → "Đã ghi vào Kho: PHIEN-12" → dòng 9 đạt', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/overview');
  const card = await askGen(page, 'ghi phiên hôm nay vào Kho', CARD);

  await expect(card).toContainText('Đề xuất · Ghi vào Kho Ryan');
  await expect(card).toContainText('Bảng');
  await expect(card).toContainText('Phiên');
  await expect(card).toContainText('Bản ghi mới');
  const table = card.getByTestId('gen-kho-table');
  await expect(table.locator('thead th')).toHaveText(['Trường', 'Sẽ ghi']);
  await expect(table.locator('tbody th')).toHaveText(['Chủ đề', 'Ngày', 'Đã chốt', 'Việc tiếp']);
  await expect(table.locator('tbody tr').first()).toContainText('Gen-Harness v0.1.50 — Gen nhớ và ghi Kho có mã PIN');
  await expect(card).toContainText('Cần mã PIN');
  await expect(card.getByTestId('gen-kho-warning')).toHaveText(WARNING);
  expect((await khoCalls(page.request)).calls).toBe(0); // chưa Xác nhận ⇒ chưa có lời gọi ghi nào

  await card.getByRole('button', { name: 'Xác nhận và ghi Kho' }).click();
  await enterPin(page); // 423 PIN_REQUIRED → hộp PIN → gửi lại
  await expect(card).toContainText('Đã ghi vào Kho: PHIEN-12');
  await expect(card.getByRole('button', { name: 'Xác nhận và ghi Kho' })).toHaveCount(0);

  const calls = await khoCalls(page.request);
  expect(calls.calls).toBe(1);
  expect(calls.writes.map((w) => [w.tool, w.code])).toEqual([['kho_create', 'PHIEN-12']]);

  // Việc Sếp cần làm: dòng 9 "Gen ghi Kho" (không bắt buộc) đã đạt sau lần ghi Kho thật đầu tiên.
  await page.goto('/guide/viec-sep');
  const row = page.getByRole('region', { name: 'Gen ghi Kho' });
  await expect(row).toBeVisible();
  await expect(row.getByTestId('boss-result')).toContainText('Đạt');
  await expect(row).toContainText('Không bắt buộc');
  await expect(row.getByRole('button')).toHaveCount(0);
  await expect(page.getByText('Đã đạt 0/6 dòng bắt buộc')).toBeVisible(); // không tính vào bắt buộc
});

test('Bấm Huỷ ⇒ không ghi gì: mock ghi nhận 0 lời gọi /hub/kho/write', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/overview');
  const card = await askGen(page, 'ghi phiên hôm nay vào Kho', CARD);
  await card.getByRole('button', { name: 'Huỷ' }).click();
  await expect(card).toContainText('Đã huỷ — không ghi gì vào Kho');
  await expect(card.getByRole('button', { name: 'Xác nhận và ghi Kho' })).toHaveCount(0);
  expect((await khoCalls(page.request)).calls).toBe(0);
  // Chưa ghi gì thật ⇒ dòng 9 "Gen ghi Kho" ở Việc Sếp cần làm vẫn chưa đạt.
  const res = await page.request.get('/api/v1/boss-checks');
  expect(((await res.json()) as { results: { kho_write?: unknown } }).results.kho_write ?? null).toBeNull();
});

test('Gen đề xuất sửa Việc: cột "Hiện tại" → "Sẽ ghi"; Sửa đổi trường rồi ghi; ghi sai ⇒ "Chưa chắc đã ghi" rồi bấm lại được', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/overview');
  const card = await askGen(page, 'cập nhật việc xong vào Kho', CARD);
  const table = card.getByTestId('gen-kho-table');
  await expect(table.locator('thead th')).toHaveText(['Trường', 'Hiện tại', 'Sẽ ghi']);
  await expect(table.locator('tbody tr').first()).toContainText('Đang làm');
  await expect(table.locator('tbody tr').first()).toContainText('Xong');
  await expect(card).toContainText('VIEC-12 · Soạn báo giá ván MDF E1');

  // Sửa: bảng / mã bản ghi khoá cứng (không có ô), Trạng thái là ô chọn, Ngày xong là ô ngày.
  await card.getByRole('button', { name: 'Sửa' }).click();
  await expect(card.getByLabel('Trạng thái')).toHaveValue('Xong');
  await expect(card.getByLabel('Ngày xong')).toHaveAttribute('type', 'date');
  await expect(card.getByLabel('Bảng')).toHaveCount(0);
  await card.getByLabel('Trạng thái').selectOption('Chờ duyệt');

  await hubSim(page.request, { kho: 'uncertain' });
  await card.getByRole('button', { name: 'Xác nhận và ghi Kho' }).click();
  await enterPinIfAsked(page);
  const alert = card.getByRole('alert');
  await expect(alert).toContainText('Chưa chắc đã ghi — Sếp mở Kho kiểm trước khi bấm lại');
  await expect(alert.getByText('Chi tiết kỹ thuật')).toBeVisible();
  await expect(card).not.toContainText('Đã ghi vào Kho');
  expect((await khoCalls(page.request)).writes).toHaveLength(0);

  await hubSim(page.request, { kho: 'ok' });
  await card.getByRole('button', { name: 'Xác nhận và ghi Kho' }).click();
  await enterPinIfAsked(page);
  await expect(card).toContainText('Đã ghi vào Kho: VIEC-12');
  const calls = await khoCalls(page.request);
  expect(calls.calls).toBe(2); // một lần không chắc + một lần ghi thật
  expect(calls.writes.map((w) => [w.tool, w.code])).toEqual([['kho_update', 'VIEC-12']]);
});

test('Token thiếu quyền ghi Kho: khoá Xác nhận + nút "Mở thẻ Gen-hub"; tick quyền + Kiểm tra ⇒ thẻ tự mở khoá', async ({ page }) => {
  test.setTimeout(90_000);
  await hubSim(page.request, { write: 'missing', link: 'on' });
  await page.goto('/overview');
  const card = await askGen(page, 'ghi phiên hôm nay vào Kho (thiếu quyền)', CARD);
  await expect(card.getByRole('button', { name: 'Xác nhận và ghi Kho' })).toBeDisabled();
  await expect(card.getByTestId('gen-kho-missing')).toContainText('Gen-hub chưa cấp quyền ghi Kho');

  await card.getByRole('button', { name: 'Mở thẻ Gen-hub' }).click();
  await expect(page).toHaveURL(/\/connections#genhub$/);
  const write = page.getByTestId('hub-write-scopes');
  await expect(write).toBeVisible();
  await expect(write).toContainText('Quyền ghi Kho (tuỳ chọn)');
  await expect(write.getByText('Chưa', { exact: true })).toHaveCount(2);
  await expect(write).toContainText('Vào Gen-hub tick quyền kho_create, kho_update cho token của Gen-Harness rồi bấm Kiểm tra.');
  await expect(write).toContainText('Gen chỉ ghi khi Sếp bấm Xác nhận + nhập mã PIN trên thẻ đề xuất.');

  // Sếp tick quyền ghi ở Gen-hub (mock: hook) rồi bấm Kiểm tra (cần PIN) ⇒ "Có" ×2; thẻ đề xuất mở khoá.
  await hubSim(page.request, { write: 'ok' });
  await page.locator('[data-gen-target="mcp.hub_link.test"]').click();
  await enterPinIfAsked(page);
  await expect(write.getByText('Có', { exact: true })).toHaveCount(2);
  await expect(write).toContainText('Đủ quyền ghi Kho (Phiên, Việc).');
  await expect(card.getByRole('button', { name: 'Xác nhận và ghi Kho' })).toBeEnabled();
  expect((await khoCalls(page.request)).calls).toBe(0);
});

test('mock ghi nhận mã lỗi theo hook: HUB_LINK_OFF khi Gen-hub chưa nối ⇒ câu thân thiện + nút mở Kết nối › Gen-hub; không ghi gì', async ({ page }) => {
  test.setTimeout(90_000);
  await resetMock(page.request, 'finished'); // Gen-hub CHƯA nối
  await loginAsOwner(page);
  await page.goto('/overview');
  const card = await askGen(page, 'ghi phiên hôm nay vào Kho', CARD);
  await card.getByRole('button', { name: 'Xác nhận và ghi Kho' }).click();
  await enterPinIfAsked(page);
  const alert = card.getByRole('alert');
  await expect(alert).toContainText('Gen-hub đang tắt — vào Kết nối › Gen-hub bấm Kiểm tra để bật lại.');
  await expect(alert.getByText('Chi tiết kỹ thuật')).toBeVisible();
  await card.getByRole('button', { name: 'Mở Kết nối › Gen-hub' }).click();
  await expect(page).toHaveURL(/\/connections#genhub$/);
  expect((await khoCalls(page.request)).writes).toHaveLength(0);
  // Hook p3 chung vẫn dùng được (đảm bảo `p3Hook` import có tác dụng trong spec này).
  expect(await p3Hook(page.request, 'mcp', 'khoCalls')).toMatchObject({ calls: 1 });
});
