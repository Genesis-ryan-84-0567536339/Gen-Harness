import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { loginAsOwner, openDesign, resetMock, resultsDir, settle, setUiPrefs, type DesignOptions } from './support';

/**
 * docs/handoff/07 §1: put the app next to the design at 1440 and 1280 and
 * compare. Phase 1 builds the shell only, so the comparison covers the
 * sidebar and the header; full-page screenshots of both are saved for review
 * in test-results/visual/.
 */
interface Scenario {
  name: string;
  viewport: { width: number; height: number };
  appPath: string;
  design: DesignOptions;
  sidebar: 'full' | 'rail';
}

const SCENARIOS: Scenario[] = [
  { name: 'overview-1440', viewport: { width: 1440, height: 900 }, appPath: '/overview', design: {}, sidebar: 'full' },
  { name: 'overview-1280', viewport: { width: 1280, height: 800 }, appPath: '/overview', design: {}, sidebar: 'full' },
  {
    name: 'inbox-1440',
    viewport: { width: 1440, height: 900 },
    appPath: '/inbox',
    design: { clicks: ['Hàng đợi & Hành động', 'Hộp thư ý nghĩa'] },
    sidebar: 'full',
  },
  { name: 'rail-1280', viewport: { width: 1280, height: 800 }, appPath: '/overview', design: { sidebarMode: 'rail' }, sidebar: 'rail' },
];
const HEADER = 58;
/** Fraction of differing pixels allowed per region. What remains is icon
 *  rasterisation: the design draws Phosphor as a web font, the app as SVG. */
const MAX_DIFF_RATIO = Number(process.env.VISUAL_MAX_DIFF ?? 0.015);

const outDir = join(resultsDir, 'visual');

function crop(png: PNG, x: number, y: number, w: number, h: number): PNG {
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, x, y, w, h, 0, 0);
  return out;
}

function compare(name: string, a: PNG, b: PNG) {
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1, includeAA: false });
  writeFileSync(join(outDir, `${name}-diff.png`), PNG.sync.write(diff));
  return { diffPixels: n, ratio: Number((n / (a.width * a.height)).toFixed(5)) };
}

async function shot(page: Page, file: string): Promise<PNG> {
  const buf = await page.screenshot({ path: join(outDir, file), animations: 'disabled', caret: 'hide' });
  return PNG.sync.read(buf);
}

test.beforeAll(() => {
  mkdirSync(outDir, { recursive: true });
});

for (const sc of SCENARIOS) {
  test(`shell matches the design · ${sc.name}`, async ({ browser, baseURL }) => {
    const vp = sc.viewport;
    const context = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, baseURL });
    const designPage = await context.newPage();
    await openDesign(designPage, sc.design);
    const design = await shot(designPage, `design-${sc.name}.png`);

    const appPage = await context.newPage();
    await setUiPrefs(appPage, { sidebarMode: sc.sidebar });
    await resetMock(appPage.request, 'finished');
    await loginAsOwner(appPage);
    await appPage.goto(sc.appPath);
    await expect(appPage.getByText('tự trị 4')).toBeVisible();
    await expect(appPage.locator('.sb-avatar')).toHaveText('CL');
    await expect(appPage.locator('.sb-nav .sb-item').first()).toBeVisible();
    await settle(appPage);
    const app = await shot(appPage, `app-${sc.name}.png`);

    const side = sc.sidebar === 'full' ? 244 : 60;
    const regions = {
      sidebar: [0, 0, side, vp.height],
      header: [side, 0, vp.width - side, HEADER],
    } as const;
    const report: Record<string, { diffPixels: number; ratio: number }> = {};
    for (const [region, [x, y, w, h]] of Object.entries(regions)) {
      const a = crop(design, x, y, w, h);
      const b = crop(app, x, y, w, h);
      writeFileSync(join(outDir, `${sc.name}-${region}-design.png`), PNG.sync.write(a));
      writeFileSync(join(outDir, `${sc.name}-${region}-app.png`), PNG.sync.write(b));
      report[region] = compare(`${sc.name}-${region}`, a, b);
    }
    writeFileSync(join(outDir, `report-${sc.name}.json`), JSON.stringify(report, null, 2));
    console.log(`visual ${sc.name}: ${JSON.stringify(report)}`);
    for (const [k, r] of Object.entries(report)) {
      expect.soft(r.ratio, `${sc.name} ${k} differs in ${r.diffPixels} px`).toBeLessThanOrEqual(MAX_DIFF_RATIO);
    }
    await context.close();
  });
}
