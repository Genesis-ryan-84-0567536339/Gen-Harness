import { expect, test, type Locator } from '@playwright/test';
import { OWNER, SETUP_TOKEN, apiCall, loginAsOwner, resetMock } from './support';

/**
 * v0.1.55 (G2 — Thiết lập gọn, mock, tất định): sau mã thiết lập + Owner + PIN (làm bằng API như các spec khác), phần còn lại
 * của trình thiết lập chỉ hỏi TÊN TỔ CHỨC và NGUỒN AI — tổng cộng không quá 4 ô nhập. Mọi bước khác điền sẵn mặc định:
 * xưng hô "Sếp", sàng lọc 900 giây / 500 tin / lô 250 / tin cậy 0,6, mẫu agent (không tin thử), mức tự trị 4 + một dòng ghi chú ranh
 * giới (không còn ô tích), thẻ gợi ý "Mời đội ngũ" có "Để sau", sao lưu tự bật 02:00 giữ 7 bản.
 */

interface Sent {
  n: number;
  body: Record<string, unknown>;
}

test('Thiết lập gọn: từ bước 3 tới Hoàn tất chỉ gõ tên tổ chức + mã xác thực nguồn AI (≤ 4 ô), còn lại là mặc định', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await resetMock(page.request, 'fresh');
  await apiCall(page, 'PUT', '/setup/steps/1', { token: SETUP_TOKEN, language: 'vi', mode: 'empty' });
  await apiCall(page, 'PUT', '/setup/steps/2', {
    token: SETUP_TOKEN, display_name: 'Anh Cơ La (Ryan)', email: 'ryan@genesis.vn', password: 'mot-cau-rat-dai-de-nho-2026', pin: OWNER.pin, pin_confirm: OWNER.pin,
  });

  // Ghi lại payload từng PUT /setup/steps/N do giao diện gửi (chỉ kiểm hình dạng — không in mật khẩu / PIN).
  const sent: Sent[] = [];
  page.on('request', (r) => {
    const m = /\/api\/v1\/setup\/steps\/(\d+)$/.exec(new URL(r.url()).pathname);
    if (m && r.method() === 'PUT') sent.push({ n: Number(m[1]), body: (r.postDataJSON() ?? {}) as Record<string, unknown> });
  });
  let inputs = 0;
  const type = async (field: Locator, text: string) => {
    inputs += 1;
    await field.fill(text);
  };

  await page.goto('/setup');
  const next = page.getByRole('button', { name: /Tiếp tục/ });
  const skip = page.getByRole('button', { name: 'Để sau', exact: true });

  // Bước 3 — chỉ Tên tổ chức; múi giờ / tiền tệ / xưng hô điền sẵn.
  await expect(page.getByText('Bước 3/12')).toBeVisible();
  await expect(next).toBeDisabled();
  await type(page.getByLabel('Tên tổ chức'), 'Genesis Trading');
  await expect(page.getByLabel('Sếp tự xưng là')).toHaveValue('Sếp');
  await expect(page.getByLabel('Agent gọi Sếp là')).toHaveValue('Sếp');
  await expect(next).toBeEnabled();
  await next.click();

  // Bước 4 — nguồn AI: đăng nhập Google (PIN + mã xác thực) rồi đi tiếp.
  await expect(page.getByRole('heading', { name: 'Bộ não AI' })).toBeVisible();
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Mã PIN xác nhận thao tác' })).toBeVisible();
  await page.keyboard.type(OWNER.pin);
  await expect(page.getByRole('link', { name: 'Mở trang đăng nhập Google' })).toBeVisible({ timeout: 5000 });
  await type(page.getByLabel('Mã xác thực'), '4/0AbCd-EfGh');
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(page.getByText('ryan.genesis@gmail.com').first()).toBeVisible({ timeout: 5000 });
  await expect(next).toBeEnabled();
  await next.click();
  await page.request.post('/api/v1/__mock/pin_expire', { data: {} });

  // Bước 5–6 (kênh, nhóm) là tuỳ chọn: Để sau.
  await expect(page.getByRole('heading', { name: 'Kết nối kênh' })).toBeVisible();
  await skip.click();
  await expect(page.getByRole('heading', { name: 'Chọn nhóm lắng nghe' })).toBeVisible();
  await skip.click();

  // Bước 7 — một câu hỏi "ngành nào"; ngưỡng / trọng số nằm trong "Nâng cao" (đóng sẵn).
  await expect(page.getByRole('heading', { name: 'Sàng lọc dữ liệu' })).toBeVisible();
  await expect(page.getByTestId('step7-industry')).toBeVisible();
  await expect(page.getByText('Sếp làm ngành nào?')).toBeVisible();
  await expect(page.locator('details', { has: page.getByText('Nâng cao — lịch sàng lọc và từng quy tắc') })).not.toHaveAttribute('open', /.*/);
  await expect(page.locator('details', { has: page.getByText('Nâng cao — trọng số chấm điểm') })).not.toHaveAttribute('open', /.*/);
  await expect(next).toBeEnabled();
  await next.click();

  // Bước 8 — chọn mẫu là xong (không tin thử, không gọi model).
  await expect(page.getByRole('heading', { name: 'Agent đầu tiên' })).toBeVisible();
  await expect(page.getByTestId('step8-note')).toBeVisible();
  await expect(page.getByLabel('Tên agent')).not.toHaveValue('');
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.getByText(/Đã tạo agent/)).toBeVisible();
  await next.click();

  // Bước 9 — mức 4 giữ sẵn, MỘT dòng ghi chú thay ô tích "Tôi đã đọc…".
  await expect(page.getByRole('heading', { name: 'Tự trị & ranh giới' })).toBeVisible();
  await expect(page.getByTestId('step9-ack-note')).toContainText('Bấm Tiếp tục nghĩa là Sếp đã đọc các ranh giới trên');
  await expect(page.getByTestId('step9-ack-note')).toContainText('50.000.000');
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(next).toBeEnabled();
  await next.click();

  // Bước 10 — thẻ gợi ý, nút chính "Để sau" (không có form mời trừ khi bấm "Mời ngay").
  await expect(page.getByRole('heading', { name: 'Mời đội ngũ' })).toBeVisible();
  await expect(page.getByTestId('step10-suggestion')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mời ngay' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Thêm người' })).toHaveCount(0);
  await skip.click();

  // Bước 11 — sao lưu đã tự bật 02:00 giữ 7 bản; đi tiếp là xong, không cần đổi gì.
  await expect(page.getByRole('heading', { name: 'Sao lưu' })).toBeVisible();
  await expect(page.getByTestId('step11-default')).toContainText('Hằng ngày lúc 02:00, giữ 7 bản gần nhất');
  await next.click();

  // Bước 12 — Hoàn tất.
  await expect(page.getByRole('heading', { name: 'Hoàn tất' })).toBeVisible();
  await expect(page.getByText(/Còn bước bắt buộc chưa xong/)).toHaveCount(0);
  await expect(page.getByText('Lần sàng lọc đầu tiên đã xong.')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Vào Console/ }).click();
  // v0.1.55: Owner về Mặt tiền (G5) — Opus siết thành /owner khi tích hợp
  await expect(page).toHaveURL(/\/(owner|overview)$/);

  // Tổng ô nhập từ bước 3: tên tổ chức + mã xác thực nguồn AI (+ PIN gõ phím không tính là ô).
  expect(inputs).toBeLessThanOrEqual(4);

  // Payload giữ nguyên hình dạng cũ; mặc định do giao diện / máy chủ điền.
  const body = (n: number) => sent.filter((s) => s.n === n).map((s) => s.body);
  expect(body(3)).toEqual([expect.objectContaining({ org_name: 'Genesis Trading', self_name: 'Sếp', bot_calls_me: 'Sếp' })]);
  expect(body(7)).toEqual([expect.objectContaining({ interval_seconds: 900, count_threshold: 500, min_confidence: 0.6 })]);
  const s8 = body(8);
  expect(s8).toHaveLength(1);
  expect(s8[0]).toEqual(expect.objectContaining({ name: expect.any(String), role_desc: expect.any(String) }));
  expect(s8[0]).not.toHaveProperty('try_message');
  expect(body(9)).toEqual([expect.objectContaining({ autonomy_level: 4, ack_boundaries: true })]);
  expect(body(11)).toEqual([expect.objectContaining({ frequency: 'daily', time_of_day: '02:00', retention_count: 7 })]);

  // Trạng thái cuối: chỉ 5, 6, 10 là "để sau".
  const state = (await apiCall(page, 'GET', '/setup/state')) as { finished: boolean; steps: Array<{ n: number; status: string }> };
  expect(state.finished).toBe(true);
  expect(state.steps.filter((s) => s.status === 'skipped').map((s) => s.n)).toEqual([5, 6, 10]);
});

test('Thiết lập gọn: "Mời ngay" ở bước 10 vẫn mở form mời; bước 11 "Đổi lịch" gập sẵn nhưng đổi được', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await resetMock(page.request, 'fresh', { startAtStep: 10 });
  await loginAsOwner(page);
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Mời đội ngũ' })).toBeVisible();
  await expect(page.getByTestId('step10-suggestion')).toBeVisible();
  await page.getByRole('button', { name: 'Mời ngay' }).click();
  await expect(page.getByRole('button', { name: 'Thêm người' })).toBeVisible();
  // Danh sách rỗng vẫn lưu được (không bắt buộc mời ai).
  await page.getByRole('button', { name: /Tiếp tục/ }).click();

  await expect(page.getByRole('heading', { name: 'Sao lưu' })).toBeVisible();
  const advanced = page.locator('details', { has: page.getByText('Đổi lịch (không bắt buộc)') });
  await expect(advanced).not.toHaveAttribute('open', /.*/);
  await page.getByText('Đổi lịch (không bắt buộc)').click();
  await expect(page.getByLabel('Giờ chạy (HH:MM)')).toHaveValue('02:00');
  await expect(page.getByText('[object Object]')).toHaveCount(0);
});
