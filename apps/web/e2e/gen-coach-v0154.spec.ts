import { expect, test, type Page } from '@playwright/test';
import { apiCall, loginAs, loginAsOwner, p3Hook, resetMock } from './support';

/**
 * v0.1.54 — Gen hướng dẫn (mock, tất định — không có model thật, không gọi /gen/turns): chấm đỏ → mở khung → 3 việc đúng
 * thứ tự → "Chỉ cho em" làm sáng dòng 1 của Việc Sếp cần làm; "Không dùng việc này" có hộp cảnh báo → Cài đặt có dòng đó →
 * "Bật lại"; "Đã hiểu" ở bài → bài ẩn ở cả context trình duyệt thứ 2; `?gen=coach` mở khung + thẻ; Gen tắt → /guide/viec-sep;
 * "Tắt hướng dẫn" ở Cài đặt → thẻ biến mất, chấm đỏ tắt; Tổng quan có "Đã đạt x/6 việc bắt buộc"; chuông `gen.coach`.
 * Trạng thái mock ở bộ nhớ module (test/mock-gen-coach.ts) — `resetMock` đưa về "máy mới 0/6".
 */

const CARD = 'Hôm nay của Sếp';
const TITLES = ['Nối Gen-hub', 'Kết nối Facebook', 'Đăng nhập hai tài khoản Google (Antigravity)'];

test.beforeEach(async ({ page }) => {
  await resetMock(page.request, 'finished');
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsOwner(page);
});

const genButton = (page: Page) => page.getByRole('button', { name: /Hỏi Gen|Đóng Gen/ });
const panel = (page: Page) => page.getByRole('complementary', { name: /Gen — trợ lý quản trị/ });
const card = (page: Page) => page.getByRole('region', { name: CARD });
const todoTitles = async (page: Page) => (await card(page).getByTestId('coach-todo').locator('.coach-card__item-title').allTextContents()).map((t) => t.trim());

test('chấm đỏ → mở khung → 3 việc đúng thứ tự → "Chỉ cho em" làm sáng dòng 1 của Việc Sếp cần làm', async ({ page }) => {
  await page.goto('/overview');
  // Chấm đỏ ở nút Gen, nút báo "có việc mới", khung KHÔNG tự mở.
  const dot = page.getByTestId('gen-coach-dot');
  await expect(dot).toBeVisible();
  await expect(page.getByRole('button', { name: /có việc mới/ })).toBeVisible();
  await expect(panel(page)).toHaveCount(0);

  await genButton(page).click();
  await expect(panel(page)).toBeVisible();
  const c = card(page);
  await expect(c).toBeVisible();
  await expect(c.getByRole('group', { name: 'Việc cần làm ngay' })).toBeVisible();
  await expect(c.getByRole('group', { name: 'Sếp biết chưa?' })).toBeVisible();
  await expect(c.getByRole('group', { name: 'Bài học hôm nay · 1/19' })).toBeVisible();
  expect(await todoTitles(page)).toEqual(TITLES);
  await expect(c.getByTestId('coach-todo').first()).toHaveAttribute('data-level', 'P1');
  // Thẻ thật sự hiện ⇒ đánh dấu đã thấy ⇒ chấm đỏ tắt (sau khi tải lại cũng không bật lại).
  await expect(dot).toHaveCount(0);
  const state = (await p3Hook(page.request, 'genCoach', 'state')) as { markShownCalls: number };
  expect(state.markShownCalls).toBe(1);
  // Thẻ không gửi câu hỏi nào cho Gen (không tạo hội thoại).
  const convs = (await (await page.request.get('/api/v1/gen/conversations')).json()) as unknown[];
  expect(convs).toHaveLength(0);

  // "Chỉ cho em" → mở Việc Sếp cần làm và làm sáng dòng 1 (vòng sáng bao đúng phần tử).
  await c.getByTestId('coach-todo').first().getByRole('button', { name: 'Chỉ cho em' }).click();
  await expect(page).toHaveURL(/\/guide\/viec-sep$/);
  const row = page.locator('[data-gen-target="boss_checks.row.hub"]');
  await expect(row).toBeVisible();
  const spot = page.getByTestId('gen-spotlight');
  await expect(spot).toBeVisible();
  const ring = spot.locator('.gen-spot__ring');
  await expect(ring).toBeVisible();
  await expect(spot.getByRole('dialog', { name: 'Gen đang chỉ' })).toContainText('Nối Gen-hub');
  await expect
    .poll(async () => {
      const [r, b] = [await ring.boundingBox(), await row.boundingBox()];
      if (!r || !b) return false;
      return Math.abs(r.x - (b.x - 6)) < 10 && Math.abs(r.y - (b.y - 6)) < 10 && Math.abs(r.width - (b.width + 12)) < 14 && Math.abs(r.height - (b.height + 12)) < 14;
    })
    .toBe(true);
});

test('"Không dùng việc này" → hộp cảnh báo → xác nhận → việc biến mất → Cài đặt có dòng đó → "Bật lại" → việc quay lại', async ({ page }) => {
  await page.goto('/overview');
  await genButton(page).click();
  await expect(card(page)).toBeVisible();
  expect(await todoTitles(page)).toEqual(TITLES);

  await card(page).getByTestId('coach-todo').first().getByRole('button', { name: 'Không dùng việc này' }).click();
  const dlg = page.getByRole('dialog', { name: /Không dùng việc này\?/ });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId('coach-dismiss-warning')).toContainText('Gen không đọc được Kho Ryan');
  await expect(dlg).toContainText('Sếp bật lại được ở Cài đặt › Bộ não AI › Gen hướng dẫn');
  // "Giữ lại" không đổi gì.
  await dlg.getByRole('button', { name: 'Giữ lại' }).click();
  await expect(dlg).toHaveCount(0);
  expect(await todoTitles(page)).toEqual(TITLES);

  await card(page).getByTestId('coach-todo').first().getByRole('button', { name: 'Không dùng việc này' }).click();
  await page.getByRole('dialog', { name: /Không dùng việc này\?/ }).getByRole('button', { name: 'Xác nhận tắt việc này' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => todoTitles(page)).toEqual(['Kết nối Facebook', 'Đăng nhập hai tài khoản Google (Antigravity)', 'Đăng nhập Claude Code']);

  // Cài đặt › Bộ não AI › Gen hướng dẫn: dòng "Việc Sếp đã chọn không dùng".
  await page.goto('/system?tab=brain');
  const set = page.getByRole('region', { name: 'Gen hướng dẫn' });
  await expect(set).toBeVisible();
  const rows = set.getByTestId('coach-dismissed-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Nối Gen-hub');
  await rows.first().getByRole('button', { name: 'Bật lại' }).click();
  await expect(rows).toHaveCount(0);
  await expect(set).toContainText('Chưa có việc nào bị tắt');

  // Việc quay lại ở thẻ (khung Gen vẫn mở sau khi tải lại trang — nhớ theo người dùng).
  await page.goto('/overview');
  await expect(card(page)).toBeVisible();
  await expect.poll(() => todoTitles(page)).toEqual(TITLES);
});

test('việc khẩn P0: không có nút "Không dùng việc này"; máy chủ từ chối tắt bằng câu thân thiện', async ({ page }) => {
  await p3Hook(page.request, 'genCoach', 'scenario', { extras: ['health.channel.down'] });
  await page.goto('/overview');
  await genButton(page).click();
  const first = card(page).getByTestId('coach-todo').first();
  await expect(first).toHaveAttribute('data-level', 'P0');
  await expect(first).toContainText('Kênh Zalo đã ngắt kết nối');
  await expect(first.getByRole('button', { name: 'Chỉ cho em' })).toBeVisible();
  await expect(first.getByRole('button', { name: 'Để mai' })).toBeVisible();
  await expect(first.getByRole('button', { name: 'Không dùng việc này' })).toHaveCount(0);
  // Câu hỏi thẳng tới API (không qua nút): 422 COACH_DISMISS_NOT_ALLOWED, title tiếng Việt, không detail.
  const res = await page.request.post('/api/v1/gen/coach/items/todo%3Ahealth.channel.down', {
    data: { action: 'dismiss', confirm: true },
    headers: { 'X-CSRF-Token': (await page.context().cookies()).find((k) => k.name === 'gh_csrf')?.value ?? '' },
  });
  expect(res.status()).toBe(422);
  const body = (await res.json()) as { code: string; title: string; detail?: unknown };
  expect(body.code).toBe('COACH_DISMISS_NOT_ALLOWED');
  expect(body.title).toBe('Việc khẩn cấp không tắt được — Sếp xử lý giúp em nhé');
  expect(body.detail).toBeUndefined();
  // "Chỉ cho em" với sự cố chỉ có link ⇒ đi tới link.
  await first.getByRole('button', { name: 'Chỉ cho em' }).click();
  await expect(page).toHaveURL(/\/connections$/);
});

test('"Đã hiểu" ở bài → bài ẩn; context trình duyệt thứ 2 cũng không thấy bài đó', async ({ page, browser, baseURL }) => {
  await page.goto('/overview');
  await genButton(page).click();
  const lesson = card(page).getByRole('group', { name: 'Bài học hôm nay · 1/19' });
  await expect(lesson).toBeVisible();
  await expect(lesson).toContainText('Hỏi Gen thay vì tự dò menu');
  await lesson.getByRole('button', { name: 'Đã hiểu' }).click();
  await expect(card(page).getByRole('group', { name: /Bài học hôm nay/ })).toHaveCount(0);
  // Việc và mẹo khác vẫn còn.
  await expect(card(page).getByRole('group', { name: 'Việc cần làm ngay' })).toBeVisible();
  await expect(card(page).getByRole('group', { name: 'Sếp biết chưa?' })).toBeVisible();

  // Context 2 (trình duyệt khác của cùng Sếp): không thấy bài đã hiểu.
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL });
  try {
    const page2 = await ctx2.newPage();
    await loginAsOwner(page2);
    await page2.goto('/overview');
    await genButton(page2).click();
    await expect(card(page2)).toBeVisible();
    await expect(card(page2).getByRole('group', { name: 'Việc cần làm ngay' })).toBeVisible();
    await expect(card(page2).getByRole('group', { name: /Bài học hôm nay/ })).toHaveCount(0);
  } finally {
    await ctx2.close();
  }
  // Lộ trình học (Trợ giúp): bài 1 "Đã hiểu"; "Học lại" đưa về chưa học.
  await page.goto('/help');
  const curr = page.getByTestId('help-curriculum');
  await expect(curr).toContainText('Lộ trình học cùng Gen');
  const rows = curr.getByTestId('curriculum-lesson');
  await expect(rows).toHaveCount(19);
  await expect(rows.first()).toContainText('Đã hiểu');
  await rows.first().getByRole('button', { name: 'Hỏi Gen thay vì tự dò menu' }).click();
  await rows.first().getByRole('button', { name: 'Học lại' }).click();
  await expect(rows.first()).toContainText('Chưa học');
});

test('/overview?gen=coach mở khung Gen, thẻ hiện (đã bỏ tham số khỏi địa chỉ); thẻ đang thu gọn thì mở rộng', async ({ page }) => {
  const me = (await apiCall(page, 'GET', '/auth/me')) as { id: string };
  await page.addInitScript(([key, id]) => window.localStorage.setItem(key, JSON.stringify({ [id]: true })), ['gh-coach-collapsed', me.id]);
  await page.goto('/overview?gen=coach');
  await expect(page).toHaveURL(/\/overview$/);
  await expect(panel(page)).toBeVisible();
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByRole('group', { name: 'Việc cần làm ngay' })).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Thu gọn thẻ Hôm nay của Sếp' })).toBeVisible();
});

test('Gen tắt (me.features.gen=false) + ?gen=coach → chuyển tới /guide/viec-sep; không có khung Gen', async ({ page }) => {
  await apiCall(page, 'PATCH', '/gen/settings', { enabled: false });
  await page.goto('/overview?gen=coach');
  await expect(page).toHaveURL(/\/guide\/viec-sep$/);
  await expect(page.locator('h2.screen-title', { hasText: 'Việc Sếp cần làm' })).toBeVisible();
  await expect(genButton(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId('gen-coach-dot')).toHaveCount(0);
});

test('"Tắt hướng dẫn" ở Cài đặt → thẻ biến mất, chấm đỏ tắt; bật lại thì thẻ quay lại', async ({ page }) => {
  await page.goto('/system?tab=brain');
  const set = page.getByRole('region', { name: 'Gen hướng dẫn' });
  await expect(set).toBeVisible();
  await expect(page.getByTestId('gen-coach-dot')).toBeVisible();
  const sw = set.getByRole('switch', { name: 'Bật hướng dẫn' });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('gen-coach-dot')).toHaveCount(0);
  await genButton(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(card(page)).toHaveCount(0);

  // Chuông nhắc, số bài mỗi ngày, giờ yên lặng lưu được.
  await set.getByLabel('Số bài mỗi ngày').selectOption('2');
  await set.getByLabel('Giờ yên lặng từ').selectOption('22');
  await set.getByLabel('đến').selectOption('6');
  await set.getByRole('switch', { name: 'Chuông nhắc' }).click();
  await expect
    .poll(async () => (await (await page.request.get('/api/v1/gen/coach/prefs')).json()) as Record<string, unknown>)
    .toMatchObject({ enabled: false, bell: false, lessons_per_day: 2, quiet_start: 22, quiet_end: 6 });

  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(card(page)).toBeVisible();
});

test('thẻ: "Hoãn tất cả 3 ngày" gọn thẻ lại, "Bỏ hoãn" trả việc; "Tắt hướng dẫn" ở chân thẻ tắt hẳn', async ({ page }) => {
  await page.goto('/overview');
  await genButton(page).click();
  await card(page).getByRole('button', { name: 'Hoãn tất cả 3 ngày' }).click();
  await expect(card(page).getByTestId('coach-snoozed')).toBeVisible();
  await expect(card(page).getByTestId('coach-todo')).toHaveCount(0);
  await card(page).getByRole('button', { name: 'Bỏ hoãn' }).click();
  await expect.poll(() => todoTitles(page)).toEqual(TITLES);

  await card(page).getByRole('button', { name: 'Tắt hướng dẫn' }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId('gen-coach-dot')).toHaveCount(0);
});

test('Tổng quan có "Đã đạt x/6 việc bắt buộc" → Xem tới Việc Sếp cần làm; "Việc thiết lập tiếp" có "Để sau 7 ngày" (máy chủ)', async ({ page }) => {
  await page.goto('/overview');
  const line = page.getByTestId('boss-progress');
  await expect(line).toBeVisible();
  await expect(line).toContainText('Đã đạt 0/6 việc bắt buộc');
  await expect(line.getByRole('link', { name: /Xem/ })).toHaveAttribute('href', '/guide/viec-sep');

  const follow = page.getByRole('region', { name: 'Việc thiết lập tiếp' });
  await expect(follow).toBeVisible();
  await expect(follow.getByRole('button', { name: 'Ẩn', exact: true })).toHaveCount(0);
  await follow.getByRole('button', { name: 'Để sau 7 ngày' }).click();
  await expect(follow).toHaveCount(0);
  const prefs = (await (await page.request.get('/api/v1/gen/coach/prefs')).json()) as { followup_snoozed_until: string | null };
  expect(prefs.followup_snoozed_until).not.toBeNull();
  // Tải lại: vẫn ẩn (lưu ở máy chủ, không phải trình duyệt).
  await page.reload();
  await expect(page.getByTestId('boss-progress')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Việc thiết lập tiếp' })).toHaveCount(0);

  await line.getByRole('link', { name: /Xem/ }).click();
  await expect(page).toHaveURL(/\/guide\/viec-sep$/);
  // 9 dòng của Việc Sếp cần làm đều gắn mục tiêu cho Gen.
  for (const k of ['hub', 'facebook', 'agy', 'claude', 'jev', 'telegram', 'remote', 'facebook_reply', 'kho_write']) {
    await expect(page.locator(`[data-gen-target="boss_checks.row.${k}"]`)).toHaveCount(1);
  }
});

test('chuông gen.coach: thông báo mới bật chấm đỏ; bấm chuông mở khung Gen + thẻ (link /overview?gen=coach)', async ({ page }) => {
  await page.goto('/overview');
  await genButton(page).click();
  await expect(card(page)).toBeVisible();
  await expect(page.getByTestId('gen-coach-dot')).toHaveCount(0);
  await page.getByRole('button', { name: 'Đóng Gen' }).click();

  await p3Hook(page.request, 'genCoach', 'notify');
  // WebSocket notification.new kind gen.coach ⇒ làm mới ngay ⇒ chấm đỏ bật (khung không tự mở).
  await expect(page.getByTestId('gen-coach-dot')).toBeVisible();
  await expect(panel(page)).toHaveCount(0);

  await page.getByRole('button', { name: /Thông báo/ }).click();
  const item = page.getByRole('dialog', { name: 'Thông báo' }).getByRole('button', { name: /Gen hướng dẫn có việc cho Sếp/ });
  await expect(item).toBeVisible();
  await expect(item.locator('[data-icon="chalkboard-teacher"]')).toBeVisible();
  await item.click();
  await expect(panel(page)).toBeVisible();
  await expect(card(page)).toBeVisible();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByTestId('gen-coach-dot')).toHaveCount(0);
});

test('Gen hướng dẫn chỉ cho Owner: vai trò khác không có thẻ, không có Lộ trình học; API trả 403', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL });
  try {
    const page = await ctx.newPage();
    await loginAs(page, 'manager@genesis.local');
    const res = await page.request.get('/api/v1/gen/coach/today');
    expect(res.status()).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('FORBIDDEN');
    await page.goto('/help');
    await expect(page.locator('h2.screen-title', { hasText: 'Trợ giúp' })).toBeVisible();
    await expect(page.getByTestId('help-curriculum')).toHaveCount(0);
    await expect(page.getByTestId('gen-coach-dot')).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
