import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { loginAsOwner, OWNER, resetMock, resultsDir, SETUP_TOKEN } from './support';

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
    await expect(page.getByRole('tab', { name: /Tất cả/ })).toBeVisible();

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
    // Phase 2: step 4 is a real form (CLI + API keys), no longer "Sắp có".
    await expect(page.getByText('Antigravity CLI · tài khoản Google')).toBeVisible();
    await expect(page.getByText('Sắp có')).toHaveCount(0);
    await expect(page.getByText('Bước 4/12')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Bộ não AI' })).toBeVisible();
    await page.screenshot({ path: join(shots, 'setup-step4-1440.png') });
  });
});

test.describe('cụm Hàng đợi & Hành động', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request, 'finished');
    await loginAsOwner(page);
  });

  test('Tổng quan: KPI và hàng đợi hiện đúng dữ liệu mẫu, mỗi ô KPI dẫn tới màn đã lọc', async ({ page }) => {
    await page.goto('/overview');
    const channelsKpi = page.getByText('Kênh sống').locator('..').locator('..');
    await expect(channelsKpi).toContainText('4');
    await expect(page.getByText('Tỉ lệ chờ duyệt')).toBeVisible();
    await expect(page.locator('.ov-queue-row', { hasText: 'OPP-1842' })).toBeVisible();
    await expect(page.locator('.ov-spot-row', { hasText: 'Nguyễn Văn Bảo' })).toBeVisible();

    const pendingKpi = page.getByText('Tỉ lệ chờ duyệt').locator('..').locator('..');
    await pendingKpi.click();
    await expect(page).toHaveURL(/\/workbench\?status=pending/);
  });

  test('Hộp thư: tab lọc đúng số đếm; giao người khác; im lặng có chủ đích', async ({ page }) => {
    await page.goto('/inbox');
    const allTab = page.getByRole('tab', { name: /Tất cả/ });
    await expect(allTab).toBeVisible();
    const totalText = await allTab.locator('.gh-tab__count').textContent();
    const total = Number(totalText);
    expect(total).toBeGreaterThan(0);

    const alertTab = page.getByRole('tab', { name: /Cảnh báo/ });
    const alertCount = Number(await alertTab.locator('.gh-tab__count').textContent());
    await alertTab.click();
    await expect(page).toHaveURL(/tab=alert/);
    await expect(page.locator('.ib-card')).toHaveCount(alertCount);
    await expect(page.locator('.ib-card').first()).toContainText('CẢNH BÁO');

    // Giao cho người khác.
    const card = page.locator('.ib-card').first();
    await card.getByRole('button', { name: 'Giao cho người khác' }).click();
    const assignDlg = page.getByRole('dialog', { name: 'Giao cho người khác' });
    await expect(assignDlg).toBeVisible();
    await assignDlg.getByText('Chị Lan Phạm').click();
    await expect(assignDlg).toBeHidden();

    // Im lặng có chủ đích: mục biến mất khỏi hàng đợi.
    const cardTitle = (await card.locator('.ib-card__title').textContent())!.trim();
    await card.getByRole('button', { name: 'Im lặng có chủ đích' }).click();
    const silenceDlg = page.getByRole('dialog', { name: 'Im lặng có chủ đích' });
    await expect(silenceDlg).toBeVisible();
    await silenceDlg.getByRole('button', { name: 'Im lặng mục này' }).click();
    await expect(silenceDlg).toBeHidden();
    await expect(page.locator('.ib-card', { hasText: cardTitle })).toHaveCount(0);
    await expect(alertTab.locator('.gh-tab__count')).toHaveText(String(alertCount - 1));
  });

  test('Việc & Nhắc hẹn: việc quá hạn tô đỏ', async ({ page }) => {
    await page.goto('/tasks');
    const overdueRow = page.locator('.tk-row', { hasText: 'TSK-0410' });
    await expect(overdueRow).toBeVisible();
    await expect(overdueRow).toHaveClass(/tk-row--overdue/);
    await expect(overdueRow).toContainText('hạn');
    const okRow = page.locator('.tk-row', { hasText: 'TSK-0412' });
    await expect(okRow).not.toHaveClass(/tk-row--overdue/);
  });
});

test.describe('cụm Quan hệ & Đối tượng', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request, 'finished');
    await loginAsOwner(page);
  });

  test('Nhóm & Con người: lọc theo độ nhiệt, bật/tắt BOT cho một người', async ({ page }) => {
    await page.goto('/directory');
    await expect(page.locator('.gh-card', { hasText: 'Vận hành Genesis — Quý 4' })).toBeVisible();
    await expect(page.getByText('Chỉ khi được tag').first()).toBeVisible();

    await page.getByRole('tab', { name: 'Con người' }).click();
    await expect(page).toHaveURL(/dt=people/);
    await expect(page.getByText('Nguyễn Văn Bảo')).toBeVisible();
    await expect(page.getByText('Trịnh Mỹ Duyên')).toBeVisible();

    await page.getByRole('group', { name: 'Độ nhiệt' }).getByRole('button', { name: 'Lạnh' }).click();
    await expect(page).toHaveURL(/heat=cold/);
    await expect(page.getByText('Đặng Hữu Trí')).toBeVisible();
    await expect(page.getByText('Nguyễn Văn Bảo')).toHaveCount(0);

    const row = page.locator('tr', { hasText: 'Đặng Hữu Trí' });
    await expect(row.getByText('Chưa gán')).toBeVisible();
    await row.getByRole('button', { name: 'Đổi' }).click();
    const dlg = page.getByRole('dialog', { name: 'Thiết lập BOT + tự trị' });
    await expect(dlg).toBeVisible();
    await dlg.getByText('Key Account junior').click();
    await dlg.getByRole('button', { name: 'Lưu' }).click();
    await expect(dlg).toBeHidden();
    await expect(row.getByText('Key Account junior')).toBeVisible();
  });

  test('Hồ sơ sống: xem 5 điểm và "Vì sao hệ thống nghĩ vậy"', async ({ page }) => {
    await page.goto('/profile?id=p-bao');
    await expect(page.getByText('Nguyễn Văn Bảo', { exact: true })).toBeVisible();
    await expect(page.getByText('Zalo', { exact: false }).first()).toBeVisible();
    const heatScore = page.locator('.pf-score', { hasText: 'Độ nóng' });
    await expect(heatScore).toContainText('87');
    await expect(page.getByText('Anh Bảo thích nói chuyện thẳng', { exact: false })).toBeVisible();

    await heatScore.getByRole('button', { name: /Vì sao/ }).click();
    const evidence = page.getByRole('dialog', { name: /Nguyễn Văn Bảo/ });
    await expect(evidence).toBeVisible();
    await expect(evidence).toContainText('87/100');
    await expect(evidence.locator('.gh-dialog__actions').getByRole('button', { name: 'Đóng' })).toBeVisible();
  });

  test('Sổ tay nhận thức: ghim một mục, nén ngay, xem lịch sử nén', async ({ page }) => {
    await page.goto('/notebook');
    await expect(page.locator('.nb-detail__name')).toHaveText('Nguyễn Văn Bảo');
    const line = page.locator('.nb-line', { hasText: 'Đang so sánh giá với Minh Long' });
    await expect(line).toBeVisible();
    const pinBtn = line.getByRole('button', { name: 'Ghim mục này' });
    await pinBtn.click();
    await expect(line.getByRole('button', { name: 'Bỏ ghim mục này' })).toBeVisible();

    await expect(page.getByText('Lần 14', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Nén ngay' }).click();
    await expect(page.getByText('Nén lần thứ 15', { exact: false })).toBeVisible();
    await expect(page.getByText('Lần 15', { exact: false })).toBeVisible();
  });

  test('Tài liệu: tải lên một tệp mới rồi xem lại trong danh sách', async ({ page }) => {
    await page.goto('/documents');
    await expect(page.getByText('BaoGia_ThanhPhat_Q4.docx')).toBeVisible();

    await page.getByRole('button', { name: 'Tải tài liệu lên' }).click();
    const dlg = page.getByRole('dialog', { name: 'Tải tài liệu lên' });
    await dlg.getByLabel('Tiêu đề').fill('Biên bản nghiệm thu tháng 9');
    await dlg.locator('#doc-file').setInputFiles({ name: 'nghiem-thu.txt', mimeType: 'text/plain', buffer: Buffer.from('nội dung mẫu') });
    await dlg.getByRole('button', { name: 'Tải lên' }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByText('Biên bản nghiệm thu tháng 9')).toBeVisible();

    await page.getByText('Biên bản nghiệm thu tháng 9').click();
    const detail = page.getByRole('dialog', { name: 'Biên bản nghiệm thu tháng 9' });
    await expect(detail).toBeVisible();
    await expect(detail.getByText('role:owner')).toBeVisible();
    await expect(detail.getByRole('link', { name: /Xem \/ tải xuống/ })).toHaveAttribute('href', /\/documents\/.+\/content/);
  });
});

test.describe('cụm Bản đồ quan hệ', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request, 'finished');
    await loginAsOwner(page);
  });

  test('chuyển 4 chế độ, lọc trong Danh sách, cầu nối nổi bật ở Người↔Người và Nhóm↔Nhóm', async ({ page }) => {
    await page.goto('/graph');
    await expect(page.getByRole('heading', { name: 'Bản đồ quan hệ', level: 2 })).toBeVisible();
    await expect(page.getByText('Nguyễn Văn Bảo')).toBeVisible();

    // Lọc: Độ nóng ≥ 80 chỉ còn khách/nhân sự nóng.
    await page.getByRole('button', { name: /Độ nóng/ }).click();
    await page.getByRole('option', { name: '≥ 80' }).click();
    await expect(page).toHaveURL(/heat=high/);
    await expect(page.getByText('Trần Văn Hậu')).toBeVisible();
    await expect(page.getByText('Đặng Hữu Trí')).toHaveCount(0);

    // Người↔Người: Trần Minh Khoa và Nguyễn Thu Hà là cầu nối (bridge_score > 0), tô nổi bật.
    await page.getByRole('radio', { name: 'Người ↔ Người' }).click();
    await expect(page).toHaveURL(/mode=people/);
    await expect(page.getByText('Người là cầu nối')).toBeVisible();
    const bridgeStat = page.locator('.gp-stat-row', { hasText: 'Nguyễn Thu Hà' });
    await expect(bridgeStat).toContainText('cầu nối');

    // Nhóm↔Nhóm: cạnh Vận hành↔Tài chính mang mã người cầu nối (PER-0007 · Nguyễn Thu Hà).
    await page.getByRole('radio', { name: 'Nhóm ↔ Nhóm' }).click();
    await expect(page).toHaveURL(/mode=groups/);
    await expect(page.getByText('Vận hành Genesis — Quý 4').first()).toBeVisible();
    await expect(page.getByText(/người đang bắc cầu/)).toBeVisible();

    // Luồng chủ đề: danh sách rồi mở chi tiết một luồng.
    await page.getByRole('radio', { name: 'Luồng chủ đề' }).click();
    await expect(page).toHaveURL(/mode=topics/);
    const topicRow = page.getByRole('button', { name: /Mở luồng ván MDF E1/ });
    await expect(topicRow).toBeVisible();
    await topicRow.click();
    await expect(page).toHaveURL(/topic=/);
    await expect(page.getByText('Trần Minh Khoa').first()).toBeVisible();
    await expect(page.getByText('Lâm Văn Được').first()).toBeVisible();
    await page.getByRole('button', { name: 'Tất cả luồng chủ đề' }).click();
    await expect(page).not.toHaveURL(/topic=/);
  });

  test('kéo thả một node ở Người↔Người tự lưu vị trí qua PUT /graph/layout/people', async ({ page }) => {
    await page.goto('/graph?mode=people');
    const node = page.locator('.gp-node', { hasText: 'Trần Minh Khoa' });
    await expect(node).toBeVisible();
    const box = (await node.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    const put = page.waitForResponse((r) => r.url().includes('/api/v1/graph/layout/people') && r.request().method() === 'PUT');
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 90, startY + 50, { steps: 8 });
    await page.mouse.up();
    const res = await put;
    expect(res.ok()).toBe(true);
    const body = res.request().postDataJSON() as { positions: Record<string, { x: number; y: number }> };
    expect(Object.keys(body.positions).length).toBeGreaterThan(0);

    // Tải lại: vị trí đã lưu được nạp lại từ GET /graph/layout/people (không còn dịch chuyển ngẫu nhiên nữa).
    await page.reload();
    await expect(page.locator('.gp-node', { hasText: 'Trần Minh Khoa' })).toBeVisible();
  });

  test('Dựng lại đồ thị gọi POST /graph/recompute (quyền profile.write)', async ({ page }) => {
    await page.goto('/graph');
    await page.getByRole('button', { name: 'Dựng lại' }).click();
    await expect(page.getByText(/Đã dựng lại/)).toBeVisible();
  });
});

test.describe('cụm Cơ hội & Thị trường', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request, 'finished');
    await loginAsOwner(page);
  });

  test('Bảng cơ hội: kéo thả đổi giai đoạn, tổng pipeline của cột cập nhật', async ({ page }) => {
    await page.goto('/opportunity');
    await expect(page.getByRole('heading', { name: 'Bảng cơ hội', level: 2 })).toBeVisible();
    const rawCol = page.locator('.opp-col[data-stage="raw_signal"]');
    const validatedCol = page.locator('.opp-col[data-stage="validated"]');
    await expect(rawCol.locator('.opp-card', { hasText: 'OPP-1851' })).toBeVisible();
    const rawCountBefore = Number(await rawCol.locator('.opp-col__count').textContent());
    const validatedCountBefore = Number(await validatedCol.locator('.opp-col__count').textContent());

    const patch = page.waitForResponse((r) => r.url().includes('/opportunities/') && r.url().includes('/stage') && r.request().method() === 'PATCH');
    await rawCol.locator('.opp-card', { hasText: 'OPP-1851' }).dragTo(validatedCol.locator('.opp-col__drop'));
    const res = await patch;
    expect(res.ok()).toBe(true);
    expect(res.request().postDataJSON()).toEqual({ to_stage: 'validated' });

    await expect(validatedCol.locator('.opp-card', { hasText: 'OPP-1851' })).toBeVisible();
    await expect(rawCol.locator('.opp-card', { hasText: 'OPP-1851' })).toHaveCount(0);
    await expect.poll(async () => Number(await rawCol.locator('.opp-col__count').textContent())).toBe(rawCountBefore - 1);
    await expect.poll(async () => Number(await validatedCol.locator('.opp-col__count').textContent())).toBe(validatedCountBefore + 1);
  });

  test('Bảng cơ hội: thay thế bàn phím "Chuyển sang giai đoạn…" cho kéo thả', async ({ page }) => {
    await page.goto('/opportunity');
    const card = page.locator('.opp-card', { hasText: 'OPP-1849' });
    await card.getByRole('button', { name: /Chuyển giai đoạn cho OPP-1849/ }).click();
    const dlg = page.getByRole('dialog', { name: 'Chuyển sang giai đoạn…' });
    await expect(dlg).toBeVisible();
    await dlg.getByText('Đã ráp khớp', { exact: true }).click();
    await expect(dlg).toBeHidden();
    await expect(page.locator('.opp-col[data-stage="matched"] .opp-card', { hasText: 'OPP-1849' })).toBeVisible();
  });

  test('Cung ↔ Cầu: xem lý do ghép, Giới thiệu hai bên tạo bản nháp và mở ở Bàn làm việc', async ({ page }) => {
    await page.goto('/supply');
    await expect(page.getByRole('heading', { name: 'Cung ↔ Cầu', level: 2 })).toBeVisible();
    const matchRow = page.locator('.sup-match', { hasText: '3 cont ván MDF E1 17mm' });
    await expect(matchRow).toBeVisible();
    await expect(matchRow.getByText(/Cùng mặt hàng.*\+50/)).toBeVisible();
    await expect(matchRow.getByText('khớp 94')).toBeVisible();

    const introduce = page.waitForResponse((r) => r.url().includes('/matches/') && r.url().includes('/introduce') && r.request().method() === 'POST');
    await matchRow.getByRole('button', { name: 'Giới thiệu hai bên' }).click();
    const res = await introduce;
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { draft: { id: string } };
    expect(body.draft.id).toBeTruthy();

    await expect(page).toHaveURL(new RegExp(`/workbench\\?id=${body.draft.id}`));
  });

  test('Kho hội thoại: tìm đúng người qua facet, hành động hàng loạt', async ({ page }) => {
    await page.goto('/search');
    await expect(page.getByRole('heading', { name: 'Kho hội thoại', level: 2 })).toBeVisible();
    await expect(page.getByText('Trần Văn Hậu')).toBeVisible();
    await expect(page.getByText('Trịnh Mỹ Duyên')).toBeVisible();

    await page.getByRole('button', { name: /Đã im lặng/ }).click();
    await expect(page).toHaveURL(/et=WentSilent/);
    await expect(page.getByText('Trịnh Mỹ Duyên')).toBeVisible();
    await expect(page.getByText('Trần Văn Hậu')).toHaveCount(0);
    await page.getByRole('button', { name: /Đã im lặng/ }).click(); // bỏ lọc lại

    await page.getByLabel('Chọn Trần Văn Hậu').check();
    await page.getByLabel('Chọn Đặng Hữu Trí').check();
    await page.getByRole('button', { name: /Hành động hàng loạt \(2\)/ }).click();
    const dlg = page.getByRole('dialog', { name: 'Hành động hàng loạt' });
    await dlg.getByText('Giao việc theo dõi').click();
    await dlg.getByLabel('Nội dung việc cần theo dõi').fill('Theo dõi lại trong tuần');
    const bulk = page.waitForResponse((r) => r.url().includes('/search/bulk') && r.request().method() === 'POST');
    await dlg.getByRole('button', { name: /Áp dụng cho 2 người/ }).click();
    const res = await bulk;
    expect(res.ok()).toBe(true);
    expect(res.request().postDataJSON()).toMatchObject({ action: 'task', text: 'Theo dõi lại trong tuần' });
    await expect(dlg).toBeHidden();
  });

  test('Deal & Vụ việc: đổi trạng thái deal và vụ việc', async ({ page }) => {
    await page.goto('/deals');
    await expect(page.getByRole('heading', { name: 'Deal & Vụ việc', level: 2 })).toBeVisible();
    const dealRow = page.locator('tr', { hasText: 'DEA-0092' });
    await expect(dealRow).toBeVisible();
    const dealPatch = page.waitForResponse((r) => r.url().includes('/deals/') && r.request().method() === 'PATCH');
    await dealRow.getByRole('button', { name: 'Đã chốt' }).click();
    await dealPatch;
    await expect(dealRow.getByRole('button', { name: 'Đã chốt' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('tab', { name: 'Vụ việc' }).click();
    await expect(page).toHaveURL(/dtab=cases/);
    const caseRow = page.locator('tr', { hasText: 'CAS-0017' });
    await expect(caseRow).toBeVisible();
    const casePatch = page.waitForResponse((r) => r.url().includes('/cases/') && r.request().method() === 'PATCH');
    await caseRow.getByRole('button', { name: 'Đang xử lý' }).click();
    await casePatch;
    await expect(caseRow.getByRole('button', { name: 'Đang xử lý' })).toHaveAttribute('aria-pressed', 'true');
  });
});
