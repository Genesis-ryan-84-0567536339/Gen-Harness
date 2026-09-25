import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const OUT = process.env.LIVE_OUT ?? '../test-results/live-shots';
const PIN = '246810';
const TOKEN = process.env.GH_SETUP_TOKEN ?? 'live-setup-token';

async function csrf(page: Page) {
  const c = (await page.context().cookies()).find((x) => x.name === 'gh_csrf');
  return c?.value ?? '';
}
async function call(page: Page, method: string, path: string, data?: unknown) {
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { 'X-CSRF-Token': await csrf(page) } });
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
}
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
/** Tin nhắn "từ Zalo" đi qua bridge giả → stream inbound → ingest thật. */
function inbound(...msgs: Array<{ group: string; sender: string; name: string; text: string; mention?: boolean }>) {
  execFileSync(process.env.PY ?? 'python3', [process.env.SEND_SCRIPT!, JSON.stringify(msgs)], { stdio: 'inherit' });
}

test('toàn hệ thống: thiết lập 1–7, nhận tin, sàng lọc, màn dữ liệu', async ({ page }) => {
  // Bước 1–3 qua API (đã có e2e giao diện từ giai đoạn 1).
  await call(page, 'PUT', '/setup/steps/1', { token: TOKEN, language: 'vi', mode: 'empty' });
  await call(page, 'PUT', '/setup/steps/2', { token: TOKEN, display_name: 'Anh Cơ', email: 'owner@genesis.vn',
    password: 'mot-cau-rat-dai-de-nho-2026', pin: PIN, pin_confirm: PIN });
  await call(page, 'PUT', '/setup/steps/3', { org_name: 'Genesis Trading', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND',
    self_name: 'Anh', bot_calls_me: 'Sếp' });

  await page.goto('/setup');
  const next = page.getByRole('button', { name: /Tiếp tục/ });

  // Bước 4: khoá API tới model giả tương thích OpenAI.
  await expect(page.getByRole('heading', { name: 'Bộ não AI' })).toBeVisible();
  await page.getByLabel('Loại').selectOption('openai_compat');
  await page.getByLabel('Tên hiển thị').fill('Model nội bộ');
  await page.getByLabel('Endpoint').fill('http://127.0.0.1:9911/v1');
  await page.getByLabel('Khoá API').fill('sk-live-test-9911');
  await page.getByRole('button', { name: /Thêm & kiểm tra/ }).click();
  await expect(page.getByText(/Gọi thử OK/)).toBeVisible();
  await page.getByRole('button', { name: 'Dùng model này' }).click();
  await expect(page.getByText(/fake-flash/).first()).toBeVisible();
  await shot(page, '01-step4');
  await expect(next).toBeEnabled();
  await next.click();

  // Bước 5: cảnh báo rủi ro → PIN → QR thật từ bridge → quét → hoạt động.
  await expect(page.getByRole('heading', { name: 'Kết nối kênh' })).toBeVisible();
  const zalo = page.getByRole('article', { name: 'Kênh Zalo' });
  await zalo.getByRole('button', { name: /Tạo mã QR/ }).click();
  const risk = page.getByRole('dialog', { name: 'Trước khi hiện mã QR' });
  await risk.getByRole('checkbox').check();
  await risk.getByRole('button', { name: /Tôi hiểu, hiện mã QR/ }).click();
  await expect(page.getByRole('dialog', { name: 'Mã PIN xác nhận thao tác' })).toBeVisible();
  await page.keyboard.type(PIN);
  await expect(page.getByRole('img', { name: /Mã QR đăng nhập Zalo/ })).toBeVisible();
  await shot(page, '02-step5-qr');
  await expect(zalo).toContainText(/Đang kết nối|Hoạt động/, { timeout: 30_000 });
  await expect(next).toBeEnabled({ timeout: 30_000 });
  await shot(page, '03-step5-active');
  await next.click();

  // Bước 6: danh bạ nhóm do bridge gửi; bật một nhóm.
  await expect(page.getByRole('heading', { name: 'Chọn nhóm lắng nghe' })).toBeVisible();
  const mode = page.getByLabel('Chế độ lắng nghe của Chợ thép sỉ miền Nam');
  await expect(mode).toHaveValue('off');
  await mode.selectOption('silent');
  await shot(page, '04-step6');
  await next.click();

  // Bước 7.
  await expect(page.getByRole('heading', { name: 'Sàng lọc dữ liệu' })).toBeVisible();
  await shot(page, '05-step7');
  await next.click();
  for (let i = 0; i < 4; i++) await next.click();
  await expect(page.getByRole('heading', { name: 'Hoàn tất' })).toBeVisible();

  // Tin nhắn thật đi qua bridge → Kho thô → sàng lọc (model giả) → Kho sạch.
  inbound(
    { group: 'g-si', sender: 'u-lan', name: 'Nguyễn Thị Lan', text: 'Cần 3 container thép cuộn, báo giá giúp chị' },
    { group: 'g-si', sender: 'u-tung', name: 'Trần Văn Tùng', text: 'ok cả nhà' },
    { group: 'g-si', sender: 'u-tung', name: 'Trần Văn Tùng', text: 'Kho còn tồn 20 tấn thép tấm, ai cần inbox' },
    { group: 'g-noibo', sender: 'u-x', name: 'Không nghe', text: 'Nhóm này chưa bật, không được lưu' },
  );
  await call(page, 'POST', '/refinery/run', {});
  await expect(page.getByText('Lần sàng lọc đầu tiên đã xong.')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.first-run__cell', { hasText: 'Bản ghi thô đã gom' })).toContainText('3');
  await expect(page.locator('.first-run__cell', { hasText: 'Đã vào kho sạch' })).toContainText('1');
  await shot(page, '06-step12');

  await page.goto('/raw');
  await expect(page.getByText('Cần 3 container thép cuộn').first()).toBeVisible();
  await expect(page.getByText('Nhóm này chưa bật')).toHaveCount(0);
  await shot(page, '07-raw');
  // Tin mới tới trực tiếp qua WebSocket.
  inbound({ group: 'g-si', sender: 'u-lan', name: 'Nguyễn Thị Lan', text: 'Giá 18 triệu/tấn được không em?' });
  await expect(page.getByText('Giá 18 triệu/tấn').first()).toBeVisible({ timeout: 20_000 });

  await page.goto('/rules');
  await expect(page.getByText('R-01').first()).toBeVisible();
  await shot(page, '08-rules');
  await page.goto('/clean');
  await expect(page.getByText(/Hỏi giá: Cần 3 container/).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, '09-clean');
  await page.goto('/identity');
  await shot(page, '10-identity');
  await page.goto('/system');
  await expect(page.getByRole('article', { name: 'Kênh Zalo' })).toContainText('Zalo Sếp');
  await shot(page, '11-system');
});
