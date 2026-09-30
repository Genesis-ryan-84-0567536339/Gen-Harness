import { expect, test } from '@playwright/test';
import { OWNER, SETUP_TOKEN, apiCall, loginAs, resetMock } from './support';

/**
 * v0.1.28 — hành trình đã đổi sau rà soát UX (mock, tất định):
 * - Bước 4: nguồn gọi thử lỗi báo câu dễ hiểu + chi tiết kỹ thuật thu gọn, xếp CUỐI chuỗi, xoá được; nguồn OK có
 *   "Dùng model này" còn nguyên sau khi tải lại; Tiếp tục chỉ bật khi có model.
 * - "Để sau" ở bước 7/11 dùng mặc định; bước 12 liệt kê việc còn thiếu thay vì "Mọi thứ đã sẵn sàng".
 * - Vai trò Vận hành: Trợ giúp không có lệnh máy chủ/Gen, Hướng dẫn kết nối giải thích thay vì báo lỗi.
 */
test.describe('UX v0.1.28', () => {
  test('bước 4 → 12: nguồn lỗi, model sau tải lại, xoá nguồn, việc còn thiếu', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request, 'fresh');
    await apiCall(page, 'PUT', '/setup/steps/1', { token: SETUP_TOKEN, language: 'vi', mode: 'empty' });
    await apiCall(page, 'PUT', '/setup/steps/2', {
      token: SETUP_TOKEN, display_name: 'Anh Cơ', email: 'ryan@genesis.vn', password: 'mot-cau-rat-dai-de-nho-2026', pin: OWNER.pin, pin_confirm: OWNER.pin,
    });
    await apiCall(page, 'PUT', '/setup/steps/3', { org_name: 'Genesis Trading', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND', self_name: 'Anh', bot_calls_me: 'Sếp' });

    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: 'Bộ não AI' })).toBeVisible();
    const next = page.getByRole('button', { name: /Tiếp tục/ });
    await expect(next).toBeDisabled();
    await expect(page.getByText('Cần ít nhất một nguồn gọi thử thành công để tiếp tục.')).toBeVisible();

    // Khoá quá ngắn → nói lý do ngay dưới ô.
    await page.getByLabel('Khoá API').fill('abc');
    await expect(page.getByText(/Khoá API có vẻ quá ngắn/)).toBeVisible();

    // Nguồn lỗi (địa chỉ nội bộ không gọi được).
    await page.getByLabel('Loại').selectOption('openai_compat');
    await page.getByLabel('Tên hiển thị').fill('Model sai');
    await page.getByLabel('Địa chỉ gọi (Endpoint)').fill('http://127.0.0.1:9999/v1');
    await page.getByLabel('Khoá API').fill('sk-sai-12345678');
    await page.getByRole('button', { name: 'Thêm & kiểm tra' }).click();
    const bad = page.locator('.prov-row', { hasText: 'Model sai' });
    await expect(bad.getByText(/Không gọi được địa chỉ này/)).toBeVisible();
    await expect(bad.getByText('All connection attempts failed')).toBeHidden(); // chi tiết thô thu gọn
    await expect(bad.getByText('Lỗi kết nối')).toBeVisible();
    await expect(next).toBeDisabled();

    // Nguồn tốt → thêm sau nhưng đứng TRƯỚC nguồn lỗi; có model tự chọn nên Tiếp tục bật.
    await page.getByLabel('Loại').selectOption('gemini');
    await page.getByLabel('Khoá API').fill('AIza-good-key-1234');
    await page.getByRole('button', { name: 'Thêm & kiểm tra' }).click();
    const good = page.locator('.prov-row', { hasText: 'Gemini API' });
    await expect(good.getByRole('button', { name: 'Dùng model này' })).toBeVisible();
    await expect(page.locator('.prov-row').first()).toContainText('Gemini API');
    await expect(page.locator('.prov-row').nth(1)).toContainText('Model sai');
    await expect(next).toBeEnabled();

    // Tải lại: kết quả gọi thử + nút chọn model vẫn còn (lưu ở máy chủ).
    await page.reload();
    await expect(page.locator('.prov-row', { hasText: 'Gemini API' }).getByRole('button', { name: 'Dùng model này' })).toBeVisible();
    await expect(page.getByText(/Chưa chọn thì hệ thống dùng gemini-2.5-flash/)).toBeVisible();

    // Xoá nguồn lỗi.
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Xoá Model sai' }).click();
    await expect(page.locator('.prov-row', { hasText: 'Model sai' })).toHaveCount(0);
    await next.click();

    // Bước 5 → 11: để sau hết.
    const skip = page.getByRole('button', { name: 'Để sau', exact: true });
    for (const title of ['Kết nối kênh', 'Chọn nhóm lắng nghe', 'Sàng lọc dữ liệu', 'Agent đầu tiên', 'Tự trị & ranh giới', 'Mời đội ngũ', 'Sao lưu']) {
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
      await skip.click();
    }

    // Bước 12: nói thật việc còn thiếu (kênh, nhóm) — quy tắc và sao lưu đã có mặc định, model đã có.
    await expect(page.getByRole('heading', { name: 'Hoàn tất' })).toBeVisible();
    const gaps = page.getByTestId('setup-gaps');
    await expect(gaps).toContainText('Đã lưu — còn 2 việc để hệ thống chạy đầy đủ');
    await expect(gaps).toContainText('Chưa kết nối kênh chat nào');
    await expect(gaps).not.toContainText('quy tắc sàng lọc');
    await expect(gaps).not.toContainText('sao lưu');
    await expect(gaps).not.toContainText('model AI');
    await expect(page.getByText('Mọi thứ đã sẵn sàng')).toHaveCount(0);
    await expect(page.locator('.summary')).toContainText('Gemini API (gemini-2.5-flash)');
  });

  test('Vận hành: Trợ giúp theo vai trò, Hướng dẫn kết nối không báo lỗi', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request, 'finished');
    await loginAs(page, 'operator@genesis.local');
    await page.goto('/help');
    await expect(page.getByText('Cần giúp về tài khoản')).toBeVisible();
    await expect(page.getByText('genh update')).toHaveCount(0);
    await page.goto('/guide');
    await expect(page.getByText('Việc kết nối do Owner làm')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Thử lại' })).toHaveCount(0);
  });
});
