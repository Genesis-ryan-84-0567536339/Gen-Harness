import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { OWNER, resetMock, resultsDir, SETUP_TOKEN } from './support';

const shots = join(resultsDir, 'visual');

test.describe('auth', () => {
  test.beforeEach(async ({ request }) => resetMock(request, 'finished'));

  test('401 sends to /login?next=, login returns there, Đăng xuất goes back to /login', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/inbox');
    await expect(page).toHaveURL(/\/login\?next=%2Finbox/);
    await page.screenshot({ path: join(shots, 'login-1440.png') });

    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Mật khẩu', { exact: true }).fill('sai-mat-khau-roi');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Email hoặc mật khẩu không đúng.')).toBeVisible();

    await page.getByLabel('Mật khẩu', { exact: true }).fill(OWNER.password);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole('heading', { name: 'Hộp thư ý nghĩa', level: 2 })).toBeVisible();
    await expect(page.locator('.hd-group')).toHaveText('Hàng đợi & Hành động');
    await expect(page.getByText('Màn hình này được dựng ở giai đoạn sau')).toBeVisible();

    await page.getByRole('button', { name: /Anh Cơ La/ }).click();
    await page.getByRole('menuitem', { name: 'Đăng xuất' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('role filtering: the operator only sees what /navigation returns', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('operator@genesis.local');
    await page.getByLabel('Mật khẩu', { exact: true }).fill(OWNER.password);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page).toHaveURL(/\/overview$/);
    await expect(page.getByRole('link', { name: /Plugin & Tiện ích/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Điều khiển hệ thống/ })).toHaveCount(0);
    await page.goto('/system');
    await expect(page.getByText('Vai trò của bạn không có quyền xem màn này')).toBeVisible();
  });

  test('rail mode keeps working and persists', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Mật khẩu', { exact: true }).fill(OWNER.password);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: /Anh Cơ La/ }).click();
    await page.getByRole('menuitem', { name: 'Thu gọn thanh bên' }).click();
    await expect(page.locator('.app')).toHaveAttribute('data-sidebar', 'rail');
    await page.getByRole('button', { name: 'Tầng dữ liệu' }).click();
    await expect(page).toHaveURL(/\/raw$/);
    await page.reload();
    await expect(page.locator('.app')).toHaveAttribute('data-sidebar', 'rail');
  });
});

test.describe('owner setup', () => {
  test.beforeEach(async ({ request }) => resetMock(request, 'fresh'));

  test('428 → /setup; steps 1–3 against the API; progress survives a reload', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/overview');
    await expect(page).toHaveURL(/\/setup$/);
    await page.goto(`/setup?token=${SETUP_TOKEN}`);
    await expect(page.getByRole('heading', { name: 'Chào mừng' })).toBeVisible();
    await expect(page.getByLabel('Mã thiết lập')).toHaveValue(SETUP_TOKEN);
    await page.screenshot({ path: join(shots, 'setup-step1-1440.png') });
    await page.getByLabel('Mã thiết lập').press('Enter');

    await expect(page.getByRole('heading', { name: 'Tài khoản Owner' })).toBeVisible();
    const next = page.getByRole('button', { name: /Tiếp tục/ });
    await expect(next).toBeDisabled();
    await page.getByLabel('Tên hiển thị').fill('Anh Cơ La (Ryan)');
    await page.getByLabel('Email').fill('ryan@genesis.vn');
    await page.getByLabel('Mật khẩu', { exact: true }).fill('mot-cau-rat-dai-de-nho-2026');
    await page.getByLabel('Mã PIN (6 số) — chữ số 1/6').click();
    await page.keyboard.type('246810');
    await page.getByLabel('Nhập lại PIN — chữ số 1/6').click();
    await page.keyboard.type('246810');
    await expect(next).toBeEnabled();
    await page.screenshot({ path: join(shots, 'setup-step2-1440.png') });
    await next.click();

    await expect(page.getByRole('heading', { name: 'Tổ chức & xưng hô' })).toBeVisible();
    await page.getByLabel('Tên tổ chức').fill('Genesis Trading');
    await page.getByLabel('Sếp tự xưng là').fill('Anh');
    await expect(page.locator('.setup-preview__line')).toContainText('Dạ Sếp');
    await page.getByLabel('Agent gọi Sếp là').fill('anh Ryan');
    await expect(page.locator('.setup-preview__line')).toContainText('Dạ Anh Ryan');
    await expect(page.getByLabel('Múi giờ')).toHaveValue('Asia/Ho_Chi_Minh');
    await expect(page.getByLabel('Tiền tệ')).toHaveValue('VND');
    await page.screenshot({ path: join(shots, 'setup-step3-1440.png') });
    await page.getByLabel('Tên tổ chức').press('Enter');

    await expect(page.getByRole('heading', { name: 'Bộ não AI' })).toBeVisible();
    await expect(page.getByText('Sắp có')).toBeVisible();
    await expect(page.getByText('Bước 4/12')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Bộ não AI' })).toBeVisible();
    await page.screenshot({ path: join(shots, 'setup-step4-1440.png') });
  });
});
