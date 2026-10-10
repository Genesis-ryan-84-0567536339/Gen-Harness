import { expect, test, type Page } from '@playwright/test';
import { apiCall, loginAs, loginAsOwner, p3Hook, resetMock } from './support';

/**
 * v0.1.55 (G5) — Mặt tiền Owner (/owner/*) trên máy chủ giả (tất định, test/mock-owner.ts — chỉ ĐỌC):
 * Owner đăng nhập mở "/" ⇒ /owner thấy Hôm nay của Sếp + 4 số + "Gen lọc giúp"; Quan hệ có 4 danh sách và bấm dòng mở Hồ sơ sống;
 * Việc 3 nhóm; Hỏi Gen nhúng khung chat; Thêm › Cài đặt nâng cao ⇒ Console, nút "← Về Mặt tiền" quay lại; < 760px thanh dưới
 * 5 nút; vai nhân viên mở "/" như cũ và mở /owner bị chuyển; trạng thái rỗng/lỗi có "Chi tiết kỹ thuật"; Gen tắt.
 */

const COACH_CARD = 'Hôm nay của Sếp';
const rail = (page: Page) => page.getByRole('navigation', { name: 'Mặt tiền' });
const tabbar = (page: Page) => page.getByRole('navigation', { name: 'Thanh dưới' });
const back = (page: Page) => page.getByTestId('back-to-front');

async function noObjectText(page: Page): Promise<void> {
  expect(await page.locator('body').innerText()).not.toContain('[object Object]');
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
}

test.describe('v0.1.55 · Mặt tiền Owner (máy tính)', () => {
  test.beforeEach(async ({ page }) => {
    await resetMock(page.request, 'finished');
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('Owner mở "/" ⇒ /owner: Hôm nay của Sếp, Cần Sếp duyệt, 4 số, Bản tin, "Gen lọc giúp", gợi ý', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/owner$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hôm nay');
    await expect(page.getByRole('region', { name: COACH_CARD })).toBeVisible();

    const review = page.getByTestId('owner-review');
    await expect(review.getByTestId('owner-review-row')).toHaveCount(4);
    await expect(review).toContainText('Gen đề xuất: Soạn nháp tin gửi đi (cần mã PIN)');
    await expect(review.getByTestId('owner-review-row').nth(1)).toHaveAttribute('href', '/workbench?id=draft-1');

    const kpis = page.getByTestId('owner-kpis');
    await expect(kpis.getByTestId('owner-kpi-hot')).toContainText('Khách nóng');
    await expect(kpis.getByTestId('owner-kpi-hot')).toContainText('3');
    await expect(kpis.getByTestId('owner-kpi-cooling')).toContainText('Quan hệ nguội');
    await expect(kpis.getByTestId('owner-kpi-open_opps')).toContainText('2,4 tỷ ₫');
    await expect(kpis.getByTestId('owner-kpi-overdue_promises')).toContainText('Lời hứa quá hạn');
    await expect(page.getByTestId('owner-briefing')).toContainText('3 bản nháp chờ Sếp duyệt');
    await expect(page.getByTestId('owner-filter-value')).toContainText('Gen lọc giúp');
    await expect(page.getByTestId('owner-filter-value')).toContainText('128 tin rác/trùng, bớt 94 lượt gọi AI');
    await expect(page.getByTestId('owner-suggest-apply_standard').getByRole('link', { name: 'Mở' })).toHaveAttribute('href', '/system?tab=brain#chuan');
    await expect(page.getByTestId('owner-suggest-background_key_missing').getByRole('link', { name: 'Mở' })).toHaveAttribute('href', '/system?tab=brain');
    await expect(page.getByTestId('owner-progress')).toContainText('việc bắt buộc đã xong');
    // Chữ đời thường: không có thuật ngữ kỹ thuật ở Hôm nay.
    expect(await page.getByTestId('owner-today').innerText()).not.toMatch(/\b(model|token|API)\b/i);
    await noObjectText(page);
    await noHorizontalScroll(page);
  });

  test('thanh trái 6 mục; Phân tích "sắp có" bị khoá; không có thanh dưới', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/owner');
    await expect(rail(page).getByRole('link')).toHaveText(['Hôm nay', 'Việc', 'Quan hệ', 'Hỏi Gen', 'Thêm']);
    const soon = rail(page).getByRole('button', { name: /Phân tích/ });
    await expect(soon).toBeDisabled();
    await expect(soon).toContainText('sắp có');
    await expect(rail(page).getByTestId('owner-nav-today')).toHaveAttribute('aria-current', 'page');
    await expect(tabbar(page)).toHaveCount(0);
    await rail(page).getByRole('link', { name: 'Quan hệ' }).click();
    await expect(page).toHaveURL(/\/owner\/quan-he$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Quan hệ');
  });

  test('Quan hệ: 4 danh sách; bấm dòng mở Hồ sơ sống, "← Về Mặt tiền" quay lại', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/owner/quan-he');
    await expect(page.getByRole('tab')).toHaveText(['Khách nóng', 'Nguội dần', 'Cầu nối', 'Cung ↔ Cầu']);
    const rows = page.getByTestId('owner-rel-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('Trần Văn Hậu');
    await expect(rows.first()).toContainText('Độ nóng 91');

    const expected = { cooling: '42 ngày chưa liên lạc', bridges: 'Nối 5 cặp nhóm', matches: 'Khớp 88%' } as const;
    for (const [list, metric] of Object.entries(expected)) {
      await page.getByTestId(`owner-rel-tab-${list}`).click();
      await expect(page.getByTestId('owner-rel-panel')).toHaveAttribute('data-list', list);
      await expect(page.getByTestId('owner-rel-panel')).toContainText(metric);
      await expect(page).toHaveURL(new RegExp(`list=${list}$`));
    }
    expect(await page.getByTestId('owner-relations').innerText()).not.toMatch(/\b(model|token|API)\b/i);

    await page.getByTestId('owner-rel-tab-hot').click();
    await expect(page.getByTestId('owner-rel-panel')).toHaveAttribute('data-list', 'hot');
    await rows.first().click();
    await expect(page).toHaveURL(/\/profile\?id=p-hau$/);
    await expect(page.locator('.content')).toContainText('Trần Văn Hậu');
    await expect(back(page)).toBeVisible();
    await back(page).click();
    await expect(page).toHaveURL(/\/owner$/);
  });

  test('4 số ở Hôm nay mở đúng danh sách ở Quan hệ', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/owner');
    await page.getByTestId('owner-kpi-cooling').click();
    await expect(page).toHaveURL(/\/owner\/quan-he\?list=cooling$/);
    await expect(page.getByTestId('owner-rel-tab-cooling')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('owner-rel-row').first()).toContainText('Hoàng Thị Lan và Phạm Quốc Minh');
  });

  test('Việc: Hộp thư đã lọc, Bàn làm việc, Việc & Nhắc hẹn — đếm + link sâu', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/owner/viec');
    await expect(page.getByTestId('owner-group-count-inbox')).toHaveText('7');
    await expect(page.getByTestId('owner-group-count-desk')).toHaveText('3');
    await expect(page.getByTestId('owner-group-count-tasks')).toHaveText('5');
    await expect(page.getByText('Hộp thư đã lọc', { exact: true })).toBeVisible();
    await expect(page.getByText('Bàn làm việc', { exact: true })).toBeVisible();
    await expect(page.getByText('Việc & Nhắc hẹn', { exact: true })).toBeVisible();
    await page.getByTestId('owner-group-open-desk').click();
    await expect(page).toHaveURL(/\/workbench(\?|$)/);       // Bàn làm việc tự mở bản nháp đầu tiên
    await expect(back(page)).toBeVisible();
  });

  test('Hỏi Gen: khung chat Gen bên phải; câu gợi ý chỉ điền sẵn ô nhập', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/owner/gen');
    const gen = page.getByTestId('owner-gen-panel');
    await expect(gen.getByRole('complementary', { name: /Gen — trợ lý quản trị/ })).toBeVisible();
    const box = await gen.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThan(700); // máy tính: panel bên phải
    await page.getByRole('complementary', { name: 'Gợi ý câu hỏi' }).getByRole('button', { name: /Nhắc tôi gọi lại khách/ }).click();
    await expect(gen.getByLabel('Câu hỏi cho Gen')).toHaveValue('Nhắc tôi gọi lại khách lúc 3 giờ chiều');
    await expect(gen.locator('.gen-msg')).toHaveCount(0);
    await noObjectText(page);
  });

  test('Thêm: một dòng mỗi dịch vụ; Facebook → /social; Cài đặt nâng cao ⇒ Console, "← Về Mặt tiền" quay lại', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/owner/them');
    const rows = page.getByTestId('owner-conn-row');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(3);
    await expect(rows.filter({ hasText: 'Facebook' }).first()).toHaveAttribute('href', '/social');

    const adv = page.getByRole('link', { name: 'Cài đặt nâng cao' });
    await expect(adv).toHaveAttribute('href', '/overview');
    await adv.click();
    await expect(page).toHaveURL(/\/overview$/);
    await expect(page.locator('aside.sb')).toBeVisible();           // khung Console đầy đủ
    await expect(back(page)).toHaveAccessibleName('Về Mặt tiền');
    await expect(back(page)).toContainText('← Về Mặt tiền');
    await back(page).click();
    await expect(page).toHaveURL(/\/owner$/);
    await expect(page.getByTestId('owner-today')).toBeVisible();
  });

  test('"/" của Owner không còn về /overview: Console chỉ mở bằng đường rõ ràng', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/overview');
    await expect(page).toHaveURL(/\/overview$/);               // vào thẳng Console vẫn được
    await page.goto('/');
    await expect(page).toHaveURL(/\/owner$/);
    await page.goto('/owner/khong-co-trang-nay');
    await expect(page).toHaveURL(/\/owner$/);                  // đường lạ dưới /owner về Hôm nay
  });

  test('?gen=coach: "/" giữ tham số tới Mặt tiền, thẻ Hôm nay của Sếp hiện, tham số bị bỏ khỏi địa chỉ', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/?gen=coach');
    await expect(page).toHaveURL(/\/owner$/);
    await expect(page.getByRole('region', { name: COACH_CARD })).toBeVisible();
    await expect(page.getByRole('region', { name: COACH_CARD }).getByTestId('coach-todo').first()).toBeVisible();
  });

  test('Gen tắt: ?gen=coach ⇒ /guide/viec-sep như hiện nay; Hỏi Gen giải thích + link Bộ não AI', async ({ page }) => {
    await loginAsOwner(page);
    await apiCall(page, 'PATCH', '/gen/settings', { enabled: false });
    await page.goto('/?gen=coach');
    await expect(page).toHaveURL(/\/guide\/viec-sep$/);
    await page.goto('/owner/gen');
    await expect(page.getByText('Gen đang tắt')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Mở Bộ não AI' })).toHaveAttribute('href', '/system?tab=brain');
    await expect(page.getByTestId('owner-gen-panel')).toHaveCount(0);
  });

  test('Bản tin từ chuông: "/?gen=<mã>" của Owner ⇒ Mặt tiền, mở Bản tin ở Hỏi Gen', async ({ page }) => {
    await loginAsOwner(page);
    const seeded = (await apiCall(page, 'POST', '/gen/__mock/briefing', { slot: 'sang' })) as { conversation_id: string };
    await page.goto(`/?gen=${seeded.conversation_id}`);
    await expect(page).toHaveURL(/\/owner\/gen$/);
    await expect(page.getByTestId('owner-gen-panel').locator('.gen-msg--briefing')).toContainText('Bản tin');
  });

  test('rỗng: chữ đời thường ở cả 3 màn dữ liệu', async ({ page }) => {
    await loginAsOwner(page);
    await p3Hook(page.request, 'owner', 'scenario', { mode: 'empty' });
    await page.goto('/owner');
    await expect(page.getByText('Chưa có gì chờ Sếp duyệt')).toBeVisible();
    await expect(page.getByTestId('owner-briefing')).toHaveCount(0);
    await expect(page.getByTestId('owner-filter-value')).toHaveCount(0);
    await page.goto('/owner/quan-he');
    await expect(page.getByText('Chưa có khách nóng')).toBeVisible();
    await page.goto('/owner/viec');
    await expect(page.getByText('Chưa có việc nào')).toBeVisible();
    await noObjectText(page);
  });

  test('lỗi: câu thân thiện + "Chi tiết kỹ thuật"; Thử lại khi máy chủ khoẻ lại', async ({ page }) => {
    await loginAsOwner(page);
    await p3Hook(page.request, 'owner', 'scenario', { mode: 'error' });
    for (const path of ['/owner', '/owner/quan-he', '/owner/viec']) {
      await page.goto(path);
      const err = page.getByTestId('owner-error');
      await expect(err).toBeVisible();
      await expect(err.getByText('Chi tiết kỹ thuật')).toBeVisible();
      await noObjectText(page);
    }
    await p3Hook(page.request, 'owner', 'scenario', { mode: 'data' });
    await page.goto('/owner/viec');
    await expect(page.getByTestId('owner-group-inbox')).toBeVisible();
  });
});

test.describe('v0.1.55 · Mặt tiền Owner (điện thoại 390px)', () => {
  test.beforeEach(async ({ page }) => {
    await resetMock(page.request, 'finished');
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('thanh dưới đúng 5 nút, không có thanh trái; bấm chuyển màn; không tràn ngang', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/owner$/);
    await expect(tabbar(page).getByRole('link')).toHaveText(['Hôm nay', 'Việc', 'Quan hệ', 'Hỏi Gen', 'Thêm']);
    await expect(rail(page)).toHaveCount(0);
    const bar = await tabbar(page).boundingBox();
    expect(bar!.y + bar!.height).toBeGreaterThan(843);          // dính đáy màn
    await noHorizontalScroll(page);
    for (const [label, path, title] of [['Việc', /\/owner\/viec$/, 'Việc'], ['Quan hệ', /\/owner\/quan-he$/, 'Quan hệ'], ['Thêm', /\/owner\/them$/, 'Thêm'], ['Hôm nay', /\/owner$/, 'Hôm nay']] as const) {
      await tabbar(page).getByRole('link', { name: label }).click();
      await expect(page).toHaveURL(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
      await expect(tabbar(page).getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
      await noHorizontalScroll(page);
    }
  });

  test('Hỏi Gen: Gen chiếm cả màn giữa đầu trang và thanh dưới', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/owner/gen');
    const gen = page.getByTestId('owner-gen-panel');
    await expect(gen.getByLabel('Câu hỏi cho Gen')).toBeVisible();
    const g = await gen.boundingBox();
    const bar = await tabbar(page).boundingBox();
    expect(g!.width).toBeGreaterThan(380);
    expect(g!.height).toBeGreaterThan(500);
    expect(g!.y + g!.height).toBeLessThanOrEqual(bar!.y + 1);   // không bị thanh dưới che
    await expect(page.getByRole('complementary', { name: 'Gợi ý câu hỏi' })).toBeHidden();
    await noHorizontalScroll(page);
  });

  test('trong Console trên điện thoại, nút về Mặt tiền vẫn có (chỉ mũi tên) và không làm tràn header', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/overview');
    await expect(back(page)).toBeVisible();
    await expect(back(page)).toHaveAccessibleName('Về Mặt tiền');
    await noHorizontalScroll(page);
    await back(page).click();
    await expect(page).toHaveURL(/\/owner$/);
  });
});

test.describe('v0.1.55 · nhân viên không có Mặt tiền', () => {
  test.beforeEach(async ({ page }) => {
    await resetMock(page.request, 'finished');
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  for (const email of ['operator@genesis.local', 'manager@genesis.local', 'auditor@genesis.local']) {
    test(`${email.split('@')[0]}: mở "/" như cũ; mở /owner bị chuyển; không có nút Về Mặt tiền; API Owner 403`, async ({ page }) => {
      const ownerApiCalls: string[] = [];
      page.on('request', (r) => {
        if (r.url().includes('/api/v1/owner/')) ownerApiCalls.push(r.url());
      });
      await loginAs(page, email);
      await page.goto('/');
      await expect(page).toHaveURL(/\/(overview|inbox)$/);       // màn đầu tiên của vai, như cũ
      await expect(page.locator('aside.sb')).toBeVisible();
      await expect(back(page)).toHaveCount(0);

      await page.goto('/owner');
      await expect(page).not.toHaveURL(/\/owner/);
      await expect(page).toHaveURL(/\/(overview|inbox)$/);
      await page.goto('/owner/quan-he');
      await expect(page).not.toHaveURL(/\/owner/);
      expect(ownerApiCalls).toEqual([]);

      for (const path of ['today', 'relations?list=hot', 'tasks']) {
        const r = await page.request.get(`/api/v1/owner/${path}`);
        expect(r.status(), path).toBe(403);
      }
      const state = (await p3Hook(page.request, 'owner', 'state')) as { nonOwnerCalls: string[] };
      expect(state.nonOwnerCalls).toHaveLength(3);
    });
  }

  test('chưa đăng nhập mở /owner ⇒ về trang đăng nhập (next=/owner)', async ({ page }) => {
    await page.goto('/owner');
    await expect(page).toHaveURL(/\/login\?next=%2Fowner$/);
  });
});
