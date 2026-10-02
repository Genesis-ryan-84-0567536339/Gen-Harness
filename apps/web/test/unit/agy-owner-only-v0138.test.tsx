import { createRef, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { BindingsPage, CliProfile, Provider, SetupStepStatus } from '@gen-harness/contracts';
import { ApiScreen } from '../../src/screens/api/ApiScreen';
import { CliCard } from '../../src/screens/system/CliCard';
import { Step4Brain } from '../../src/setup/Step4Brain';
import { SETUP_STEPS } from '../../src/setup/steps';
import { qk } from '../../src/lib/queries';
import { queryClient } from '../../src/lib/queryClient';

/**
 * v0.1.38 (F-22): Antigravity CLI (agy) chỉ dùng cho Gen của Sếp — thẻ CLI, bảng gán model và bước thiết lập phải nói rõ;
 * lỗi 409 AGY_OWNER_GEN_ONLY hiện câu thân thiện, mã lỗi chỉ nằm trong "Chi tiết kỹ thuật".
 */
const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  url: string;
  method: string;
  body: unknown;
}
function mockFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const c = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(c);
      return handler(c);
    }),
  );
  return calls;
}

const ME = {
  id: 'u', email: 'owner@genesis.local', display_name: 'Anh Cơ La (Ryan)',
  role: { code: 'owner', name: 'Owner — Sếp' },
  org: { id: 'o', name: 'x', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
  addressing: { self: 'Anh', bot_calls_me: 'Sếp' }, pin_verified_until: null,
  permissions: { 'system.read': 'all', 'system.manage': 'all' },
};

function renderWith(ui: ReactElement, qc: QueryClient) {
  qc.setQueryData(qk.me, ME);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
const freshClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const AGY_REASON = 'Model của Antigravity CLI chỉ dùng cho Gen của Sếp — luật an toàn, không tắt được.';
const AGY_TITLE = 'Model của Antigravity CLI chỉ dùng cho Gen của Sếp. Sàng lọc tin và trực việc nên dùng khoá API hoặc Claude Code CLI.';

const PROVIDERS: Provider[] = [
  {
    id: 'pv-agy', kind: 'antigravity_cli', name: 'Antigravity CLI', endpoint: null, failover_rank: 1, enabled: true, auth_state: 'ok',
    keys: [], models: [{ id: 'm-agy', model_name: 'gemini-3-pro', daily_quota: null, used_today: 0 }],
  },
  {
    id: 'pv-gemini', kind: 'gemini', name: 'Gemini API', endpoint: null, failover_rank: 2, enabled: true, auth_state: 'ok',
    keys: [{ id: 'k1', label: 'GEM-KEY-01', last4: '9f2a', enabled: true, cooldown_until: null, quota_left_pct: null }],
    models: [{ id: 'm1', model_name: 'gemini-2.5-flash', daily_quota: 3000, used_today: 400 }],
  },
];

const BINDINGS: BindingsPage = {
  items: [
    {
      agent_key: 'core.refinery', label: 'Sàng lọc & suy luận chính',
      binding: { model_id: 'm-agy', model_name: 'gemini-3-pro', provider_name: 'Antigravity CLI', temperature: 0.2, context_tokens: 64000, rule_codes: [] },
      blocked_reason: AGY_REASON,
    },
    { agent_key: 'core.gen', label: 'Gen của Sếp', binding: null, blocked_reason: null },
  ],
  models: [
    { id: 'm-agy', model_name: 'gemini-3-pro', provider_name: 'Antigravity CLI', enabled: true },
    { id: 'm1', model_name: 'gemini-2.5-flash', provider_name: 'Gemini API', enabled: true },
  ],
};

function apiHandler(c: Call): Response | null {
  if (c.url.includes('/agents/bindings') && c.method === 'GET') return json(200, BINDINGS);
  if (c.url.includes('/failover-rules')) return json(200, []);
  if (c.url.includes('/providers/credentials')) return json(200, []);
  if (c.url.includes('/cli/profiles')) return json(200, []);
  if (c.url.endsWith('/providers') && c.method === 'GET') return json(200, PROVIDERS);
  return null;
}

beforeEach(() => {
  document.cookie = 'gh_csrf=test-csrf';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('v0.1.38 F-22 — Antigravity CLI chỉ dùng cho Gen của Sếp', () => {
  it('thẻ CLI Antigravity có câu phạm vi, thẻ Claude Code không có', async () => {
    mockFetch(() => json(200, [] as CliProfile[]));
    renderWith(
      <>
        <CliCard canManage showCredentials={false} />
        <CliCard canManage showCredentials={false} kind="claude_code_cli" />
      </>,
      freshClient(),
    );
    const agy = screen.getByTestId('cli-card-antigravity_cli');
    const claude = screen.getByTestId('cli-card-claude_code_cli');
    expect(within(agy).getByText(/Chỉ dùng cho Gen của Sếp/)).toBeInTheDocument();
    expect(within(claude).queryByText(/Chỉ dùng cho Gen của Sếp/)).toBeNull();
  });

  it('bảng gán model: slot core.refinery có blocked_reason → nhãn "Không dùng được" kèm câu giải thích', async () => {
    mockFetch((c) => apiHandler(c) ?? json(404));
    renderWith(<ApiScreen />, freshClient());
    const badge = await screen.findByTestId('binding-blocked-core.refinery');
    expect(badge).toHaveTextContent('Không dùng được');
    expect(badge).toHaveAttribute('title', AGY_REASON);
    expect(screen.queryByTestId('binding-blocked-core.gen')).toBeNull();
    expect(document.body.textContent).not.toContain('[object Object]');
  });

  it('PUT 409 AGY_OWNER_GEN_ONLY → câu thân thiện, mã lỗi chỉ trong "Chi tiết kỹ thuật"', async () => {
    const calls = mockFetch((c) => {
      if (c.url.includes('/agents/bindings/') && c.method === 'PUT') {
        return json(409, {
          type: 'about:blank', title: AGY_TITLE, status: 409, code: 'AGY_OWNER_GEN_ONLY',
          detail: { agent_key: 'core.refinery' }, reasons: [AGY_REASON],
        });
      }
      return apiHandler(c) ?? json(404);
    });
    renderWith(<ApiScreen />, freshClient());
    const user = userEvent.setup();
    const row = (await screen.findByText('Sàng lọc & suy luận chính', { selector: '.apm-table__agent' })).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /gemini-3-pro/ }));
    const dialog = await screen.findByRole('dialog');
    // Ô chọn: model agy hiện kèm chú thích "chỉ cho Gen" khi sửa slot khác core.gen.
    await waitFor(() => expect(within(dialog).getByRole('option', { name: /gemini-3-pro — chỉ cho Gen/ })).toBeInTheDocument());
    expect(within(dialog).getByRole('option', { name: /gemini-2\.5-flash$/ })).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Model'), 'm-agy');
    await user.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(AGY_TITLE);
    const details = alert.querySelector('details.tech-detail') as HTMLElement;
    expect(details).not.toBeNull();
    expect(within(details).getByText('Chi tiết kỹ thuật')).toBeInTheDocument();
    expect(details.textContent).toContain('AGY_OWNER_GEN_ONLY');
    // Mã lỗi KHÔNG nằm ở phần câu chính (ngoài "Chi tiết kỹ thuật").
    const outside = (alert.textContent ?? '').replace(details.textContent ?? '', '');
    expect(outside).not.toContain('AGY_OWNER_GEN_ONLY');
    expect(document.body.textContent).not.toContain('[object Object]');
  });

  it('bước 4: chỉ có Antigravity CLI sẵn sàng → nhắc thêm khoá API hoặc Claude Code CLI', async () => {
    queryClient.clear();
    queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
    const agyProfile: CliProfile = { id: 'a', email: 'an@example.vn', plan_label: null, active: true, expires_at: null, state: 'ok' };
    mockFetch((c) => {
      if (c.url.includes('/cli/profiles')) return json(200, c.url.includes('kind=claude_code_cli') ? [] : [agyProfile]);
      if (c.url.endsWith('/providers') && c.method === 'GET') return json(200, [PROVIDERS[0]]);
      return json(200, []);
    });
    const meta = SETUP_STEPS.find((s) => s.n === 4)!;
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Step4Brain
            meta={meta}
            description="Bộ não AI"
            status={'pending' as SetupStepStatus}
            token=""
            setToken={() => {}}
            onSaved={() => {}}
            onNext={() => {}}
            formRef={createRef<HTMLFormElement>()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const scope = await screen.findByTestId('setup-cli-scope-antigravity_cli');
    expect(scope).toHaveTextContent('Chỉ dùng cho Gen của Sếp');
    expect(await screen.findByTestId('setup-agy-only-hint')).toHaveTextContent(
      'Gen dùng được ngay; muốn hệ thống tự sàng lọc tin và trực việc, thêm một khoá API hoặc Claude Code CLI',
    );
    expect(screen.queryByTestId('setup-cli-scope-claude_code_cli')).toBeNull();
  });

  it('bước 4: có thêm khoá API sẵn sàng → không hiện câu nhắc', async () => {
    queryClient.clear();
    queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
    const agyProfile: CliProfile = { id: 'a', email: 'an@example.vn', plan_label: null, active: true, expires_at: null, state: 'ok' };
    mockFetch((c) => {
      if (c.url.includes('/cli/profiles')) return json(200, c.url.includes('kind=claude_code_cli') ? [] : [agyProfile]);
      if (c.url.endsWith('/providers') && c.method === 'GET') return json(200, PROVIDERS);
      return json(200, []);
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Step4Brain
            meta={SETUP_STEPS.find((s) => s.n === 4)!}
            description="Bộ não AI"
            status={'pending' as SetupStepStatus}
            token=""
            setToken={() => {}}
            onSaved={() => {}}
            onNext={() => {}}
            formRef={createRef<HTMLFormElement>()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('setup-cli-scope-antigravity_cli');
    await screen.findByText('Gemini API', { selector: '.setup-row__title' });
    expect(screen.queryByTestId('setup-agy-only-hint')).toBeNull();
  });
});
