import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { SCREENS } from '@gen-harness/contracts';
import { loginAsOwner, mockHook, OWNER, resetMock, resultsDir } from './support';

/**
 * Lính gác bố cục (sau v0.1.49 — "nội dung dính biên khung"): duyệt MỌI màn (lấy từ packages/contracts/src/screens.ts)
 * + các tab chính + trang phụ (Hướng dẫn, Trợ giúp, Tài khoản, Mạng xã hội) ở 1920/1440/1024/390 với Owner, đo trong
 * <main> (bỏ header `.hd` và thanh bên) bốn lỗi trình bày:
 *
 *  - `dinh-bien` (chữ dính mép khung) — đo HỘP CHỮ THẬT: với mọi text node hiển thị (chữ sau trim dài > 1, không nằm
 *    trong script/style/select/textarea, không display:none/visibility:hidden, không position:fixed), lấy
 *    `Range.selectNodeContents(textNode).getBoundingClientRect()` (hộp glyph, đã cắt theo các tổ tiên overflow ≠ visible
 *    nằm giữa chữ và khung — chữ bị ellipsis tính tới mép vùng cắt). "Khung" = tổ tiên gần nhất có border-left-width > 0,
 *    hoặc (border-radius > 0 và nền không trong suốt), hoặc <main>, hoặc <table>. Khoảng cách hộp chữ tới mép trái/phải
 *    của khung < 6px ⇒ phát hiện. Không tính khung nhỏ ≤ 48×48px (avatar/huy hiệu chữ viết tắt căn giữa — chữ cố ý
 *    chiếm gần hết khung) — đây là quy tắc đo, không phải allowlist.
 *  - `tran-ngang` — `document.documentElement.scrollWidth > clientWidth`, hoặc vùng nội dung `.content` (overflow-x:auto)
 *    phải cuộn ngang, hoặc phần tử có `getBoundingClientRect().right > bề rộng màn + 1` (báo phần tử ngoài cùng gây tràn).
 *  - `chu-bi-cat` — phần tử một dòng (white-space: nowrap hoặc text-overflow: ellipsis) có scrollWidth > clientWidth + 2
 *    mà không có `title` (trên nó hoặc tổ tiên). Bỏ qua vùng cuộn có chủ đích (overflow-x: auto|scroll, vd dải tab cuộn
 *    ngang ở điện thoại) và chữ ẩn cho trình đọc màn hình (rộng < 4px).
 *  - `icon-rot-dong` — Icon (svg/span `data-icon`) display:block trong cha KHÔNG flex/grid mà cha có chữ ⇒ icon một dòng,
 *    chữ dòng dưới (đúng lỗi khối "Máy chủ chưa nhận yêu cầu cập nhật — xem ở Cài đặt" vỡ 3 dòng ở v0.1.44–v0.1.49).
 *
 * Ảnh: mỗi route × cỡ chụp vào `$LAYOUT_GUARD_SHOTS/<nhánh>/<w>_<route>.png` (mặc định test-results/layout-guard),
 * phát hiện nào cũng chụp thêm ảnh phóng ±40px quanh phần tử (`…__zoomN.png`). Lỗi ⇒ in bảng phát hiện gom theo
 * (loại, selector, route) kèm các cỡ màn gặp lỗi.
 *
 * Kịch bản dữ liệu: mock "finished" + ép thẻ cập nhật "Máy chủ chưa nhận yêu cầu cập nhật" (GET /system/update
 * stalled/not_picked_up) và vài sự cố ở dải "Cần Sếp xử lý" — đúng các thẻ trong ảnh Boss.
 */

interface Finding {
  kind: 'dinh-bien' | 'tran-ngang' | 'chu-bi-cat' | 'icon-rot-dong';
  selector: string;
  text: string;
  gap: number;
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * ALLOWLIST — MẶC ĐỊNH RỖNG. Chỉ thêm khi phát hiện đã được người xem ảnh xác nhận KHÔNG phải lỗi (dương tính giả của
 * phép đo, vd chữ cố ý tràn trong một hiệu ứng) hoặc đã có việc sửa riêng được ghi trong docs/reports/HANDOFF-v0.1.1.md
 * — luôn kèm `reason` nói rõ vì sao và đến khi nào. Khớp khi `kind` bằng nhau, `selector` chứa `selector` (chuỗi con)
 * và (nếu có) `route` khớp đúng route.
 */
const ALLOWLIST: Array<{ kind: Finding['kind']; selector: string; route?: string; reason: string }> = [];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1024, height: 800 },
  { width: 390, height: 844 },
] as const;

/** Tab/biến thể chính của từng màn (khoá URL thật: useUrlState trong từng màn). */
const EXTRA_ROUTES = [
  '/inbox?tab=opportunity',
  '/inbox?tab=alert',
  '/inbox?tab=approval',
  '/inbox?tab=reply',
  '/tasks?ptab=overdue',
  '/tasks?ptab=all',
  '/directory?dt=people',
  '/deals?dtab=cases',
  '/people?board=customer',
  '/people?board=candidate',
  '/people?board=student',
  '/system?tab=storage',
  '/system?tab=org',
  '/system?tab=brain',
  '/system?tab=roles',
  '/system?tab=log',
  '/guide',
  '/guide/4',
  '/guide/5',
  '/guide/6',
  '/guide/10',
  '/guide/viec-sep',
  '/help',
  '/account',
  '/social',
  '/social/ghi-facebook',
];

/** Màn trong cây SCREENS (trừ Hồ sơ sống — cần ?id=, thêm riêng bên dưới). */
const SCREEN_ROUTES = SCREENS.filter((s) => s.key !== 'profile').map((s) => `/${s.key}`);

/** Trạng thái cập nhật "máy chủ chưa nhận yêu cầu" (như ảnh Boss) — hiện UpdateNotice ở Hôm nay và thẻ ở Cài đặt. */
const UPDATE_STALLED = {
  current: 'v0.1.48',
  latest: 'v0.1.49',
  update_available: true,
  updater: 'systemd',
  linked: true,
  can_request: true,
  state: 'stalled',
  stalled_reason: 'not_picked_up',
  message: null,
  from: 'v0.1.48',
  to: 'v0.1.49',
  started_at: null,
  finished_at: null,
  requested_at: new Date(Date.now() - 20 * 60_000).toISOString(),
  release_url: null,
  release_notes: null,
  published_at: null,
  auto_update_enabled: true,
};

function branchName(): string {
  const env = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  if (env) return env.replace(/[^\w.-]+/g, '-');
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .replace(/[^\w.-]+/g, '-');
  } catch {
    return 'local';
  }
}

const SHOT_DIR = join(process.env.LAYOUT_GUARD_SHOTS || join(resultsDir, 'layout-guard'), branchName());
const slug = (route: string) => route.replace(/^\//, '').replace(/[^\w-]+/g, '_') || 'root';

/** Chạy trong trang: trả mọi phát hiện trong <main> (bỏ header .hd). Giữ thuần JS — không đóng gói hàm ngoài vào. */
function scanLayout(): Finding[] {
  const out: Finding[] = [];
  const main = document.querySelector('main');
  if (!main) return out;
  const header = main.querySelector('header.hd');
  const vw = document.documentElement.clientWidth;
  const MIN_GAP = 6;

  const r4 = (r: DOMRect | { x: number; y: number; width: number; height: number }) => ({
    x: Math.round(r.x),
    y: Math.round(r.y + window.scrollY),
    width: Math.round(r.width),
    height: Math.round(r.height),
  });
  const short = (el: Element): string => {
    const one = (e: Element) => {
      const cls = Array.from(e.classList).filter((c) => !/^(ph|ph-\w+)$/.test(c)).slice(0, 2);
      return e.tagName.toLowerCase() + (cls.length ? `.${cls.join('.')}` : '');
    };
    const p = el.parentElement;
    return p && p !== main ? `${one(p)} > ${one(el)}` : one(el);
  };
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 40);
  const transparent = (c: string) => c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  const skipped = (el: Element) => (header ? header.contains(el) : false);

  const frameOf = new Map<Element, boolean>();
  const isFrame = (el: Element): boolean => {
    const hit = frameOf.get(el);
    if (hit !== undefined) return hit;
    let v = false;
    if (el === main || el.tagName === 'TABLE') v = true;
    else {
      const cs = getComputedStyle(el);
      if (parseFloat(cs.borderLeftWidth) > 0 && cs.borderLeftStyle !== 'none') v = true;
      else if (parseFloat(cs.borderTopLeftRadius) > 0 && !transparent(cs.backgroundColor)) v = true;
    }
    frameOf.set(el, v);
    return v;
  };

  // ── (a) dính biên: hộp chữ thật (Range) so với khung gần nhất ──
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  const seen = new Set<string>();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.nodeValue ?? '').trim();
    if (text.length <= 1) continue;
    const parent = n.parentElement;
    if (!parent || skipped(parent)) continue;
    if (parent.closest('script,style,noscript,select,option,textarea,svg')) continue;
    if (!parent.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const tr = range.getBoundingClientRect();
    if (tr.width <= 0 || tr.height <= 0) continue;
    let left = tr.left;
    let right = tr.right;
    let frame: Element | null = null;
    let fixed = false;
    for (let a: Element | null = parent; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.position === 'fixed') {
        fixed = true;
        break;
      }
      if (cs.overflowX !== 'visible' && a !== main) {
        // chữ bị cắt bởi vùng này (ellipsis, cuộn ngang) — chỉ phần nhìn thấy (hộp nội dung) mới tính
        const cr = a.getBoundingClientRect();
        const cl = cr.left + a.clientLeft + parseFloat(cs.paddingLeft);
        left = Math.max(left, cl);
        right = Math.min(right, cr.left + a.clientLeft + a.clientWidth - parseFloat(cs.paddingRight));
      }
      if (isFrame(a)) {
        frame = a;
        break;
      }
    }
    if (fixed || !frame || right <= left) continue;
    const fr = frame.getBoundingClientRect();
    if (fr.width <= 48 && fr.height <= 48) continue; // avatar / huy hiệu chữ viết tắt căn giữa
    const gl = left - fr.left;
    const gr = fr.right - right;
    const gap = Math.min(gl, gr);
    if (gap < MIN_GAP) {
      const sel = `${short(frame)} » ${short(parent)} (${gl < gr ? 'trái' : 'phải'})`;
      const key = `${sel}|${clean(text)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: 'dinh-bien', selector: sel, text: clean(text), gap: Math.round(gap * 10) / 10, rect: r4(new DOMRect(left, tr.top, right - left, tr.height)) });
    }
  }

  // ── (b) tràn ngang ──
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) {
    out.push({ kind: 'tran-ngang', selector: 'html', text: `trang cuộn ngang ${de.scrollWidth - de.clientWidth}px`, gap: de.clientWidth - de.scrollWidth, rect: r4(new DOMRect(0, 0, vw, 1)) });
  }
  const content = main.querySelector('.content') ?? main;
  const contentRight = content.getBoundingClientRect().left + content.clientLeft + content.clientWidth;
  const limit = Math.min(vw, contentRight) + 1;
  if (content.scrollWidth > content.clientWidth + 1 || de.scrollWidth > de.clientWidth + 1) {
    const culprits: Element[] = [];
    const visit = (el: Element) => {
      for (const c of Array.from(el.children)) {
        if (skipped(c)) continue;
        const r = c.getBoundingClientRect();
        if (r.width > 0 && r.right > limit) {
          const cs = getComputedStyle(c);
          // con của c còn tràn hơn c? đi xuống tìm phần tử ngoài cùng gây tràn
          if (cs.overflowX === 'visible' && Array.from(c.children).some((g) => g.getBoundingClientRect().right > limit && g.getBoundingClientRect().right >= r.right - 1)) visit(c);
          else culprits.push(c);
        } else if (getComputedStyle(c).overflowX === 'visible') visit(c);
      }
    };
    visit(content);
    for (const c of culprits.slice(0, 5)) {
      const r = c.getBoundingClientRect();
      out.push({ kind: 'tran-ngang', selector: short(c), text: clean(c.textContent ?? ''), gap: Math.round(limit - 1 - r.right), rect: r4(r) });
    }
    if (!culprits.length && content.scrollWidth > content.clientWidth + 1) {
      out.push({ kind: 'tran-ngang', selector: '.content', text: `vùng nội dung cuộn ngang ${content.scrollWidth - content.clientWidth}px`, gap: content.clientWidth - content.scrollWidth, rect: r4(content.getBoundingClientRect()) });
    }
  }

  // ── (c) chữ một dòng bị cắt, không title; (d) icon block rớt dòng ──
  for (const el of Array.from(main.querySelectorAll('*'))) {
    if (skipped(el)) continue;
    if (el.closest('select,textarea,input,option')) continue;
    if (el.hasAttribute('data-icon')) {
      const p = el.parentElement;
      if (!p) continue;
      const pd = getComputedStyle(p).display;
      if (getComputedStyle(el).display === 'block' && !/flex|grid/.test(pd) && (p.textContent ?? '').trim().length > 1 && el.getBoundingClientRect().width > 0) {
        out.push({ kind: 'icon-rot-dong', selector: `${short(p)} > [icon ${el.getAttribute('data-icon')}]`, text: clean(p.textContent ?? ''), gap: 0, rect: r4(p.getBoundingClientRect()) });
      }
      continue;
    }
    if (!(el instanceof HTMLElement)) continue;
    const he = el;
    if (he.clientWidth < 4) continue;
    const cs = getComputedStyle(he);
    if (cs.whiteSpace !== 'nowrap' && cs.textOverflow !== 'ellipsis') continue;
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
    if (!(he.textContent ?? '').trim()) continue;
    if (he.scrollWidth > he.clientWidth + 2 && !he.closest('[title]')) {
      out.push({ kind: 'chu-bi-cat', selector: short(he), text: clean(he.textContent ?? ''), gap: he.clientWidth - he.scrollWidth, rect: r4(he.getBoundingClientRect()) });
    }
  }
  return out;
}

async function settled(page: Page): Promise<void> {
  await page.locator('main').first().waitFor();
  await page
    .waitForFunction(() => !document.querySelector('main .gh-skeleton, main [aria-busy="true"]'), undefined, { timeout: 5_000 })
    .catch(() => undefined);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(120);
}

/** Nhập PIN khi hộp PIN tự mở (Đánh giá con người đòi phiên PIN cho mọi lượt đọc). */
async function pinIfAsked(page: Page): Promise<void> {
  const dlg = page.getByRole('dialog', { name: 'Mã PIN xác nhận thao tác' });
  if (!(await dlg.isVisible().catch(() => false))) return;
  await page.getByLabel('Mã PIN — chữ số 1/6').click();
  await page.keyboard.type(OWNER.pin);
  await expect(dlg).toBeHidden();
  await settled(page);
}

/** Điều hướng phía trình duyệt (router lắng nghe popstate) — nhanh hơn tải lại cả trang dev. */
async function go(page: Page, route: string): Promise<void> {
  await page.evaluate((url) => {
    window.history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, route);
  // Không đợi URL khớp tuyệt đối: vài route tự chuyển hướng (vd tab đã dời chỗ) — đợi vẽ xong là đủ.
  await settled(page);
  await pinIfAsked(page);
}

test.describe('Lính gác bố cục — chữ dính biên, tràn ngang, chữ bị cắt, icon rớt dòng', () => {
  test('mọi màn × 1920/1440/1024/390 không có phát hiện', async ({ page }) => {
    test.setTimeout(240_000);
    mkdirSync(SHOT_DIR, { recursive: true });
    // ảnh phóng của lượt chạy trước không còn đúng — xoá để thư mục chỉ chứa phát hiện của lượt này
    for (const f of readdirSync(SHOT_DIR)) if (f.includes('__zoom')) rmSync(join(SHOT_DIR, f));
    await resetMock(page.request, 'finished');
    await mockHook(page.request, 'health', { issues: [{ kind: 'backup.stale' }, { kind: 'channel.down' }] });
    await loginAsOwner(page);
    await page.route('**/api/v1/system/update', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: UPDATE_STALLED }) : route.fallback(),
    );
    await page.setViewportSize(VIEWPORTS[0]);
    await page.goto('/directory?dt=people');
    await settled(page);
    const profileHref = await page.locator('main a[href*="/profile?id="]').first().getAttribute('href');
    // Hồ sơ đầu danh sách + hồ sơ mock đủ dữ liệu (tóm tắt, dòng sự kiện, tài liệu) — p-bao.
    const routes = [...SCREEN_ROUTES, ...EXTRA_ROUTES, ...new Set([...(profileHref ? [profileHref] : []), '/profile?id=p-bao'])];

    const all: Array<Finding & { route: string; w: number }> = [];
    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      for (const route of routes) {
        const t0 = Date.now();
        await go(page, route);
        await page.evaluate(() => window.scrollTo(0, 0));
        const found = (await page.evaluate(scanLayout)).filter(
          (f) => !ALLOWLIST.some((a) => a.kind === f.kind && f.selector.includes(a.selector) && (!a.route || a.route === route)),
        );
        const base = `${vp.width}_${slug(route)}`;
        await page.screenshot({ path: join(SHOT_DIR, `${base}.png`), fullPage: true });
        for (const [i, f] of found.slice(0, 8).entries()) {
          const pageH = await page.evaluate(() => document.documentElement.scrollHeight);
          const x = Math.max(0, f.rect.x - 40);
          const y = Math.max(0, f.rect.y - 40);
          const width = Math.min(vp.width - x, f.rect.width + 80);
          const height = Math.min(pageH - y, f.rect.height + 80);
          if (width > 0 && height > 0) {
            await page.screenshot({ path: join(SHOT_DIR, `${base}__zoom${i + 1}.png`), fullPage: true, clip: { x, y, width, height } }).catch(() => undefined);
          }
        }
        all.push(...found.map((f) => ({ ...f, route, w: vp.width })));
        if (process.env.LAYOUT_GUARD_VERBOSE) console.log(`${vp.width} ${route} ${found.length} phát hiện ${Date.now() - t0}ms`);
      }
    }

    if (all.length) {
      const groups = new Map<string, { kind: string; route: string; selector: string; text: string; gap: number; ws: Set<number> }>();
      for (const f of all) {
        const k = `${f.kind}|${f.route}|${f.selector}`;
        const g = groups.get(k) ?? { kind: f.kind, route: f.route, selector: f.selector, text: f.text, gap: f.gap, ws: new Set<number>() };
        g.ws.add(f.w);
        g.gap = Math.min(g.gap, f.gap);
        groups.set(k, g);
      }
      const rows = [...groups.values()].map((g) =>
        [g.kind.padEnd(13), g.route.padEnd(28), [...g.ws].join('/').padEnd(19), String(g.gap).padStart(6), ` ${g.selector}  «${g.text}»`].join(' '),
      );
      console.log(
        `\nLính gác bố cục: ${groups.size} phát hiện (${all.length} lượt) — ảnh: ${SHOT_DIR}\n` +
          `${'loại'.padEnd(13)} ${'route'.padEnd(28)} ${'cỡ màn'.padEnd(19)} ${'gap'.padStart(6)}  selector «chữ»\n` +
          rows.join('\n'),
      );
    }
    expect(all.map((f) => `${f.kind} ${f.route} @${f.w}: ${f.selector} «${f.text}» gap=${f.gap}`)).toEqual([]);
  });
});
