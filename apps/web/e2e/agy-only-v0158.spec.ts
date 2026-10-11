/**
 * v0.1.58 (hotfix) — máy Boss: Owner chỉ có Antigravity CLI (không khoá API). "Kiểm tra kết nối" đỏ 'CLI không nhận model ""',
 * ô chọn model bị ẩn, mọi vai "Chuẩn: chưa có nguồn phù hợp".
 *
 * API giả (page.route đè lên mock dùng chung, đúng hợp đồng máy chủ v0.1.58):
 *  - GET /providers: MỘT nguồn antigravity_cli; models=[] cho tới khi POST /providers/{id}/test xanh (máy chủ tự lưu
 *    gemini-3.8-flash · Vừa, không đặt mặc định);
 *  - GET /agents/bindings: core.gen có `standard` sau khi kiểm tra; vai khác `standard: null` + `standard_reason`.
 * Chạy thật với agy giả đòi --effort là ca pytest (apps/api/tests/test_agy_effort_required_v0158.py).
 */
import { expect, test, type Page } from '@playwright/test';
import { loginAsOwner, resetMock } from './support';

const PID = 'prov-agy-v0158';
const NEED_API = 'cần khoá API (Antigravity chỉ dùng cho Gen)';
const NEED_API_OR_CLAUDE = 'cần khoá API hoặc Claude Code CLI';
const NO_MODEL = 'chưa có model — bấm Kiểm tra kết nối ở Antigravity CLI';
const EFFORT_ERROR = 'CLI cần chọn mức suy nghĩ cho model “gemini-3.8-flash” (nhận: Thấp, Vừa, Cao)';

const FLASH = {
  id: 'gemini-3.8-flash',
  label: 'Gemini 3.8 Flash',
  group: 'Gemini',
  tier: 'balanced' as const,
  hint: 'cân bằng',
  source: 'cli' as const,
  efforts: ['low', 'medium', 'high'],
  default_effort: null,
  verified: true,
};

const GROUPS = [{ label: 'Gemini', models: [FLASH] }];

const STD = { model_name: 'gemini-3.8-flash', provider_name: 'Antigravity CLI', tier: 'balanced', tier_label: 'Cân bằng', effort: 'medium', temperature: 0.3, context_tokens: 6000 };

const ROLES: Array<[string, string, string]> = [
  ['core.refinery', 'Sàng lọc & suy luận chính', NEED_API],
  ['core.reply', 'Soạn lại / dịch nháp', NEED_API_OR_CLAUDE],
  ['core.gen', 'Gen — trợ lý quản trị', ''],
  ['core.briefing', 'Bản tin Gen', NEED_API],
];

type Mode = 'ok' | 'effort-error';

/** Dựng API giả có trạng thái: `tested` đổi khi POST /test xanh. */
async function mockAgyOnly(page: Page, mode: Mode) {
  const state = { tested: false };
  const testBody =
    mode === 'ok'
      ? { ok: true, latency_ms: 812, models: ['gemini-3.8-flash'], model_groups: GROUPS, models_source: 'cli', probe_model: 'gemini-3.8-flash', probe_effort: 'medium', error: null, at: new Date().toISOString() }
      : {
          ok: false,
          latency_ms: 640,
          models: [],
          model_groups: GROUPS,
          models_source: 'cli',
          error: EFFORT_ERROR,
          error_detail: 'ModelRejected: invalid model selection (--model "gemini-3.8-flash" --effort ""): Invalid model "gemini-3.8-flash" (available: low, medium, high)',
          at: new Date().toISOString(),
        };
  await page.route(/\/api\/v1\/providers(\?.*)?$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      json: [
        {
          id: PID,
          kind: 'antigravity_cli',
          name: 'Antigravity CLI',
          endpoint: null,
          failover_rank: 1,
          enabled: true,
          auth_state: 'ok',
          keys: [],
          models: state.tested && mode === 'ok' ? [{ id: 'm-flash', model_name: 'gemini-3.8-flash', daily_quota: null, used_today: 0, is_default: false, effort: 'medium' }] : [],
          last_test: state.tested ? testBody : null,
        },
      ],
    });
  });
  await page.route(new RegExp(`/api/v1/providers/${PID}/test$`), (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    state.tested = true;
    return route.fulfill({ json: testBody });
  });
  await page.route(/\/api\/v1\/agents\/bindings$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      json: {
        items: ROLES.map(([agent_key, label, why]) => ({
          agent_key,
          label,
          binding: null,
          source: 'standard',
          standard: agent_key === 'core.gen' && state.tested && mode === 'ok' ? STD : null,
          standard_reason: agent_key === 'core.gen' ? (state.tested && mode === 'ok' ? null : NO_MODEL) : why,
        })),
        models: [],
      },
    });
  });
  return state;
}

test.describe('v0.1.58 · Owner chỉ có Antigravity CLI', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request, 'finished');
    await loginAsOwner(page);
  });

  test('Kiểm tra kết nối xanh → MODEL, "Chuẩn" của Gen và lý do cho các vai còn lại', async ({ page }) => {
    await mockAgyOnly(page, 'ok');
    await page.goto('/api');
    const card = page.getByRole('article', { name: 'Antigravity CLI' });
    const table = page.locator('.apm-table');
    const row = (label: string) => table.locator('tr', { hasText: label });

    // Trước khi kiểm tra: nguồn chưa có model; mỗi vai nêu ĐÚNG lý do (không còn câu chung chung).
    await expect(card).toContainText('chưa có model');
    await expect(row('Gen — trợ lý quản trị')).toContainText(`Chuẩn: ${NO_MODEL}`);
    await expect(row('Sàng lọc & suy luận chính')).toContainText(`Chuẩn: ${NEED_API}`);
    await expect(row('Soạn lại / dịch nháp')).toContainText(`Chuẩn: ${NEED_API_OR_CLAUDE}`);

    await card.getByRole('button', { name: 'Kiểm tra kết nối' }).click();
    await expect(card.getByRole('status')).toContainText('Kết nối được');
    await expect(card).toContainText('gemini-3.8-flash · Vừa');            // ô MODEL
    await expect(card.getByRole('combobox', { name: /Model cho Antigravity CLI/ })).toBeVisible();
    await expect(row('Gen — trợ lý quản trị')).toContainText('Chuẩn: gemini-3.8-flash (tự chọn)');
    await expect(row('Gen — trợ lý quản trị').getByTestId('binding-effort-core.gen')).toContainText('Vừa (chuẩn)');
    for (const [, label, why] of ROLES.filter(([k]) => k !== 'core.gen')) {
      await expect(row(label)).toContainText(`Chuẩn: ${why}`);
      await expect(row(label)).toContainText('cần khoá API');
    }
    const body = page.locator('body');
    await expect(body).not.toContainText('chưa có nguồn phù hợp');
    await expect(body).not.toContainText('“”');
    await expect(body).not.toContainText('[object Object]');
  });

  test('Kiểm tra đỏ vì CLI đòi mức suy nghĩ → câu đúng, không có model rỗng, kèm "Chi tiết kỹ thuật"', async ({ page }) => {
    await mockAgyOnly(page, 'effort-error');
    await page.goto('/guide/4');
    const row = page.locator('.prov-row', { hasText: 'Antigravity CLI' });
    await row.getByRole('button', { name: 'Kiểm tra', exact: true }).click();
    const status = row.getByRole('status').first();
    await expect(status).toContainText(`Chưa dùng được: ${EFFORT_ERROR}`);
    await expect(status).not.toContainText('“”');
    await expect(status).not.toContainText('CLI không nhận model');
    await expect(status).not.toContainText('[object Object]');
    const detail = status.locator('details.tech-detail');
    await expect(detail.locator('summary')).toHaveText('Chi tiết kỹ thuật');
    await detail.locator('summary').click();
    await expect(detail.locator('code')).toContainText('available: low, medium, high');
  });
});
