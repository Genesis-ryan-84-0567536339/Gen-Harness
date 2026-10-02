/**
 * v0.1.38 (F-22): model của Antigravity CLI chỉ dùng cho Gen của Sếp. Màn API & Model: gán model agy cho "Sàng lọc &
 * suy luận chính" → API trả 409 AGY_OWNER_GEN_ONLY → thấy câu tiếng Việt (mã lỗi chỉ trong "Chi tiết kỹ thuật");
 * gán cho Gen của Sếp → lưu được.
 *
 * Luật cứng nằm ở API (gói agy-co-lap-api). Mock dùng chung (test/mock-p4-api.ts) chưa có slot `core.gen` và luật
 * này, nên spec chặn `/agents/bindings*` bằng page.route và trả đúng hợp đồng: GET có `binding.blocked_reason` (TRONG
 * binding, như gh/agents_api/routes.py::_binding_out), PUT trả 409
 * AGY_OWNER_GEN_ONLY (title là câu tiếng Việt, `reasons` là lý do dùng chung).
 */
import { expect, test, type APIRequestContext, type Route } from '@playwright/test';
import { loginAsOwner, resetMock } from './support';

const GEN_KEY = 'core.gen';
// Chuỗi THẬT của máy chủ: gh/providers/router.py::AGY_OWNER_ONLY_REASON và gh/agents_api/routes.py::AGY_GEN_ONLY_MSG.
const AGY_REASON = 'Antigravity CLI: chỉ dùng cho Gen của Sếp (agy chưa tắt được công cụ đọc tệp — luật an toàn, không đổi được)';
const AGY_TITLE =
  'Antigravity CLI chỉ dùng được cho Gen của Sếp — sàng lọc tin và trực việc nhận nội dung của khách nên phải dùng nguồn khác (khoá API hoặc Claude Code CLI)';

interface Binding {
  model_id: string;
  model_name: string;
  provider_name: string;
  temperature: number;
  context_tokens: number;
  rule_codes: string[];
  blocked_reason?: string | null;
}
interface Slot {
  agent_key: string;
  label: string;
  binding: Binding | null;
}
interface BindingsPayload {
  items: Slot[];
  models: Array<{ id: string; model_name: string; provider_name: string; enabled: boolean }>;
}

test.describe('v0.1.38 · Antigravity CLI chỉ dùng cho Gen của Sếp', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetMock(page.request as APIRequestContext, 'finished');
    await loginAsOwner(page);
  });

  test('gán model agy cho Sàng lọc → câu lỗi tiếng Việt; gán cho Gen → thành công', async ({ page }) => {
    const providers = (await (await page.request.get('/api/v1/providers')).json()) as Array<{ kind: string; name: string; models: Array<{ id: string }> }>;
    const agyProviders = providers.filter((p) => p.kind === 'antigravity_cli');
    const agyIds = new Set(agyProviders.flatMap((p) => p.models.map((m) => m.id)));
    const agyNames = new Set(agyProviders.map((p) => p.name));
    expect(agyIds.size).toBeGreaterThan(0);
    // Dữ liệu mẫu của mock gán sẵn model agy cho sàng lọc bằng id cố định → nhận diện thêm theo tên nguồn.
    const isAgyBinding = (b: Binding) => agyIds.has(b.model_id) || agyNames.has(b.provider_name);

    let genBinding: Binding | null = null;
    let lastModels: BindingsPayload['models'] = [];
    const putCodes: number[] = [];

    await page.route('**/api/v1/agents/bindings', async (route: Route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as BindingsPayload;
      lastModels = body.models;
      const items: Slot[] = body.items.map((s) => ({
        ...s,
        binding: s.binding ? { ...s.binding, blocked_reason: s.agent_key !== GEN_KEY && isAgyBinding(s.binding) ? AGY_REASON : null } : null,
      }));
      if (!items.some((s) => s.agent_key === GEN_KEY)) items.unshift({ agent_key: GEN_KEY, label: 'Gen của Sếp', binding: genBinding });
      await route.fulfill({ response: res, json: { ...body, items } });
    });

    await page.route('**/api/v1/agents/bindings/*', async (route: Route) => {
      const req = route.request();
      if (req.method() !== 'PUT') return route.continue();
      const key = decodeURIComponent(new URL(req.url()).pathname.split('/').pop() ?? '');
      const b = req.postDataJSON() as { model_id: string; temperature?: number; context_tokens?: number; rule_codes?: string[] };
      if (key !== GEN_KEY && agyIds.has(b.model_id)) {
        putCodes.push(409);
        return route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          // Đúng hình dạng gh.errors.conflict(): chỉ title + code, detail null.
          body: JSON.stringify({ type: 'about:blank', title: AGY_TITLE, status: 409, code: 'AGY_OWNER_GEN_ONLY', detail: null }),
        });
      }
      if (key === GEN_KEY) {
        const m = lastModels.find((x) => x.id === b.model_id)!;
        genBinding = {
          model_id: m.id, model_name: m.model_name, provider_name: m.provider_name,
          temperature: b.temperature ?? 0.3, context_tokens: b.context_tokens ?? 8000, rule_codes: b.rule_codes ?? [],
          blocked_reason: null,
        };
        putCodes.push(200);
        return route.fulfill({ status: 200, json: { agent_key: GEN_KEY, label: 'Gen của Sếp', binding: genBinding } });
      }
      return route.continue();
    });

    await page.goto('/api');
    const table = page.locator('.apm-table');
    await expect(table).toContainText('Sàng lọc & suy luận chính');

    // Thẻ Antigravity CLI nói rõ phạm vi.
    await expect(page.getByTestId('cli-card-antigravity_cli')).toContainText('Chỉ dùng cho Gen của Sếp');

    // Slot sàng lọc đang gán model agy → "Không dùng được".
    const refineryRow = table.locator('tr', { hasText: 'Sàng lọc & suy luận chính' });
    await expect(refineryRow.getByTestId('binding-blocked-core.refinery')).toContainText('Không dùng được');
    await expect(refineryRow.getByTestId('binding-blocked-core.refinery')).toHaveAttribute('title', AGY_REASON);

    // 1) Gán model agy cho Sàng lọc → 409 → câu tiếng Việt.
    await refineryRow.locator('.apm-model-pill').click();
    let dlg = page.getByRole('dialog', { name: /Sàng lọc & suy luận chính/ });
    const select = dlg.getByLabel('Model');
    const agyOption = dlg.locator('option', { hasText: 'chỉ cho Gen' }).first();
    await expect(agyOption).toBeAttached();
    await select.selectOption((await agyOption.getAttribute('value'))!);
    await expect(dlg.getByTestId('binding-agy-note')).toContainText('Chỉ dùng cho Gen của Sếp');
    await dlg.getByRole('button', { name: 'Lưu' }).click();
    const alert = dlg.getByRole('alert');
    await expect(alert).toContainText('chỉ dùng được cho Gen của Sếp');
    await expect(alert).not.toContainText('[object Object]');
    await expect(alert.locator('details.tech-detail summary')).toHaveText('Chi tiết kỹ thuật');
    // Mã lỗi chỉ nằm trong "Chi tiết kỹ thuật" (đóng sẵn → không hiển thị).
    await expect(alert.getByText(/AGY_OWNER_GEN_ONLY/)).toBeHidden();
    await alert.locator('details.tech-detail summary').click();
    await expect(alert.locator('details.tech-detail code')).toContainText('AGY_OWNER_GEN_ONLY');
    expect(putCodes).toEqual([409]);
    await dlg.getByRole('button', { name: 'Huỷ' }).click();
    await expect(dlg).toBeHidden();

    // 2) Gán model agy cho Gen của Sếp → thành công.
    const genRow = table.locator('tr', { hasText: 'Gen của Sếp' });
    await genRow.locator('.apm-model-pill').click();
    dlg = page.getByRole('dialog', { name: /Gen của Sếp/ });
    await expect(dlg.locator('option', { hasText: 'chỉ cho Gen' })).toHaveCount(0);
    const agyId = [...agyIds].find((id) => lastModels.some((m) => m.id === id))!;
    await dlg.getByLabel('Model').selectOption(agyId);
    await dlg.getByRole('button', { name: 'Lưu' }).click();
    await expect(dlg).toBeHidden();
    expect(putCodes).toEqual([409, 200]);
    const agyName = lastModels.find((m) => m.id === agyId)!.model_name;
    await expect(genRow.locator('.apm-model-pill')).toContainText(agyName);
    await expect(genRow.getByText('Không dùng được')).toHaveCount(0);
  });
});
