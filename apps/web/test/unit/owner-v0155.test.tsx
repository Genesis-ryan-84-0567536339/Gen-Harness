/**
 * v0.1.55 (G5) — Mặt tiền Owner (/owner/*): mô hình thuần, 5 màn × (tải, rỗng, lỗi có "Chi tiết kỹ thuật", có dữ liệu),
 * khung (thanh trái 6 mục / thanh dưới 5 nút < 760px, vai khác Owner về "/", ?gen=), nút "← Về Mặt tiền", cụm route.
 * Không màn nào render object (`[object Object]`); Hôm nay/Quan hệ không có chữ model/token/API; mock-owner khớp hợp đồng.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter, useLocation, type RouteObject } from 'react-router-dom';
import { hasIcon } from '@gen-harness/ui';
import { useGenStore } from '../../src/gen/genStore';
import { BackToFront } from '../../src/owner/BackToFront';
import { AskGenScreen } from '../../src/owner/AskGenScreen';
import { MoreScreen } from '../../src/owner/MoreScreen';
import { OwnerShell } from '../../src/owner/OwnerShell';
import { RelationsScreen } from '../../src/owner/RelationsScreen';
import { OwnerTasksScreen } from '../../src/owner/TasksScreen';
import { TodayScreen } from '../../src/owner/TodayScreen';
import {
  ADVANCED_SETTINGS_PATH,
  OWNER_NAV,
  OWNER_TABBAR,
  activeNavKey,
  asText,
  connectionLines,
  countText,
  filterValueText,
  kpiCards,
  moneyText,
  ownerTitle,
  progressText,
  safeLink,
} from '../../src/owner/ownerModel';
import { ownerEndpoints } from '@gen-harness/contracts';
import { routes } from '../../src/router';
import { createMock as createOwnerMock } from '../mock-owner';
import type { P2Ctx } from '../mock-phase2';

// ── dữ liệu mẫu: lấy THẲNG từ mock-owner (nếu mock và hợp đồng lệch nhau thì test này đỏ) ─────────────────────────────

const ME = (over: Record<string, unknown> = {}, role = 'owner') => ({
  id: 'u1', email: 'owner@genesis.local', display_name: 'Anh Cơ La', role: { code: role, name: role },
  org: { id: 'o1', name: 'Genesis', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
  addressing: { self: 'Anh', bot_calls_me: 'Sếp' }, pin_verified_until: null, permissions: {}, must_change_password: false,
  features: { gen: true }, ...over,
});

interface MockReply { status: number; body: unknown }

function callMock(mock: ReturnType<typeof createOwnerMock>, url: string, role = 'owner', method = 'GET'): MockReply | null {
  const u = new URL(url, 'http://x');
  let out: MockReply | null = null;
  const ctx = {
    method, path: u.pathname.replace(/^\/api\/v1/, ''), url: u, body: {}, perms: {},
    reply: (status: number, body?: unknown) => { out = { status, body }; return true; },
    problem: (status: number, code: string, title: string, extra?: Record<string, unknown>) => { out = { status, body: { status, code, title, ...extra } }; return true; },
    text: () => true, needPin: () => false, userLabel: 'x', owner: role === 'owner', role,
  } as unknown as P2Ctx;
  return mock.handle(ctx) ? out : null;
}

const BOSS = {
  rows: [
    { row: 1, key: 'hub', title: 'Gen-hub', optional: false, checks: ['hub'], done: true },
    { row: 2, key: 'facebook', title: 'Facebook', optional: false, checks: ['facebook'], done: false },
    { row: 3, key: 'agy', title: 'Google / Antigravity', optional: false, checks: [], done: false },
    { row: 5, key: 'jev', title: 'Jev', optional: true, checks: ['jev'], done: false },
    { row: 8, key: 'facebook_reply', title: 'Facebook trả lời', optional: true, checks: [], done: false },
  ],
  results: {}, required_done: 1, required_total: 6, switch_passes: 0,
};

// ── máy chủ giả ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Mode = 'data' | 'empty' | 'error' | 'hang';
const server = {
  mock: createOwnerMock({ fresh: false, emit: () => undefined, boss: () => BOSS as never }),
  mode: 'data' as Mode,
  me: ME() as unknown,
  meFails: false,
  boss: BOSS as unknown,
  bossMode: 'data' as Mode,
  calls: [] as string[],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const problem500 = () => json(500, { status: 500, code: 'INTERNAL', title: 'Máy chủ gặp lỗi', error_id: 'ERR-TEST-1' });

function stubApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      server.calls.push(url);
      if (url.includes('/auth/me')) return server.meFails ? problem500() : json(200, server.me);
      if (url.includes('/owner/')) {
        if (server.mode === 'hang') return new Promise<Response>(() => undefined);
        server.mock.hooks.scenario?.({ mode: server.mode === 'empty' ? 'empty' : server.mode === 'error' ? 'error' : 'data' } as never);
        const r = callMock(server.mock, url);
        return r ? json(r.status, r.body) : json(404, { status: 404, code: 'NOT_FOUND', title: 'Không tồn tại' });
      }
      if (url.includes('/boss-checks')) {
        if (server.bossMode === 'hang') return new Promise<Response>(() => undefined);
        if (server.bossMode === 'error') return problem500();
        return json(200, server.bossMode === 'empty' ? { ...BOSS, rows: [] } : server.boss);
      }
      if (url.includes('/notifications')) return json(200, { items: [], unread: 0 });
      return json(404, { status: 404, code: 'NOT_FOUND', title: 'Không tồn tại' });
    }),
  );
}

function setViewport(mobile: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: mobile && q.includes('max-width: 760px'), media: q, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
}

function Where() {
  const l = useLocation();
  return <div data-testid="where">{`${l.pathname}${l.search}`}</div>;
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
}

function mountScreen(ui: React.ReactElement, path = '/owner', qc: QueryClient = client()) {
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: [path] });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const SHELL_ROUTES: RouteObject[] = [
  {
    path: '/owner',
    element: <OwnerShell />,
    children: [
      { index: true, element: <TodayScreen /> },
      { path: 'quan-he', element: <RelationsScreen /> },
      { path: 'viec', element: <OwnerTasksScreen /> },
      { path: 'gen', element: <AskGenScreen /> },
      { path: 'them', element: <MoreScreen /> },
    ],
  },
  { path: '/', element: <Where /> },
  { path: '/guide/viec-sep', element: <Where /> },
  { path: '/change-password', element: <Where /> },
];

function mountShell(path: string) {
  const router = createMemoryRouter(SHELL_ROUTES, { initialEntries: [path] });
  render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** Không màn nào được để lộ object thô ra chữ. */
const noRawObjects = () => expect(document.body.textContent ?? '').not.toContain('[object Object]');

beforeEach(() => {
  server.mock = createOwnerMock({ fresh: false, emit: () => undefined, boss: () => BOSS as never });
  server.mode = 'data';
  server.me = ME();
  server.meFails = false;
  server.boss = BOSS;
  server.bossMode = 'data';
  server.calls = [];
  useGenStore.setState({ openByUser: {}, conversationId: null, conversationOwner: null, messages: [], busy: false, coachFocus: false, composerDraft: null });
  vi.stubGlobal('WebSocket', undefined);
  setViewport(false);
  stubApi();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ── mô hình thuần ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('ownerModel (thuần)', () => {
  it('thanh trái 6 mục, Phân tích "sắp có" bị khoá; thanh dưới 5 mục', () => {
    expect(OWNER_NAV.map((i) => i.label)).toEqual(['Hôm nay', 'Việc', 'Quan hệ', 'Hỏi Gen', 'Phân tích', 'Thêm']);
    expect(OWNER_NAV.filter((i) => i.soon).map((i) => i.label)).toEqual(['Phân tích']);
    expect(OWNER_TABBAR.map((i) => i.label)).toEqual(['Hôm nay', 'Việc', 'Quan hệ', 'Hỏi Gen', 'Thêm']);
    expect(OWNER_TABBAR).toHaveLength(5);
  });

  it('mục đang sáng + tiêu đề theo đường dẫn', () => {
    expect(activeNavKey('/owner')).toBe('today');
    expect(activeNavKey('/owner/')).toBe('today');
    expect(activeNavKey('/owner/quan-he')).toBe('relations');
    expect(activeNavKey('/owner/viec')).toBe('tasks');
    expect(activeNavKey('/owner/gen')).toBe('gen');
    expect(activeNavKey('/owner/them')).toBe('more');
    expect(activeNavKey('/owner/phan-tich')).toBe('today');
    expect(ownerTitle('/owner/them')).toBe('Thêm');
  });

  it('safeLink chỉ nhận đường dẫn trong Console; asText không bao giờ trả object', () => {
    expect(safeLink('/profile?id=p-hau')).toBe('/profile?id=p-hau');
    expect(safeLink('/system?tab=brain#chuan')).toBe('/system?tab=brain#chuan');
    for (const bad of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', '', ' /x y', '/\\evil', { a: 1 }, null, undefined, 5]) {
      expect(safeLink(bad)).toBe('/owner');
    }
    expect(safeLink('x', '/overview')).toBe('/overview');
    expect(asText({ a: 1 })).toBe('');
    expect(asText(['x'])).toBe('');
    expect(asText('ok')).toBe('ok');
    expect(asText(7)).toBe('7');
  });

  it('định dạng số/tiền/câu', () => {
    expect(countText(12)).toBe('12');
    expect(countText(999)).toBe('999+');
    expect(countText(1500)).toBe('999+');
    expect(countText(NaN)).toBe('—');
    expect(countText('3')).toBe('—');
    expect(moneyText(2_400_000_000)).toBe('2,4 tỷ ₫');
    expect(moneyText(3_500_000)).toBe('3,5 triệu ₫');
    expect(moneyText(850_000)).toBe('850.000 ₫');
    expect(moneyText(0)).toBe('0 ₫');
    expect(moneyText(null)).toBe('—');
    expect(filterValueText({ filtered: 128, calls_saved: 94 })).toBe('Tuần này Gen lọc giúp Sếp 128 tin rác/trùng, bớt 94 lượt gọi AI.');
    expect(filterValueText({ filtered: 0, calls_saved: 0 })).toBeNull();
    expect(filterValueText(null)).toBeNull();
    expect(progressText(4, 6)).toBe('Việc Sếp cần làm: 4/6 việc bắt buộc đã xong');
    expect(progressText(6, 6)).toBe('Việc Sếp cần làm: đã xong cả 6 việc bắt buộc');
    expect(progressText(undefined, 0)).toBe('Việc Sếp cần làm');
  });

  it('4 số mở đúng danh sách; số đếm chạm trần hiện "999+"', () => {
    const cards = kpiCards({ hot: 3, cooling: 2, open_opps: 12, open_value_vnd: 2_400_000_000, overdue_promises: 1000 });
    expect(cards.map((c) => c.key)).toEqual(['hot', 'cooling', 'open_opps', 'overdue_promises']);
    expect(cards.map((c) => c.to)).toEqual(['/owner/quan-he?list=hot', '/owner/quan-he?list=cooling', '/opportunity', '/tasks?ptab=overdue']);
    expect(cards[2].sub).toBe('2,4 tỷ ₫');
    expect(cards[3].value).toBe('999+');
    expect(kpiCards({ hot: 0, cooling: 0, open_opps: 0, open_value_vnd: 0, overdue_promises: 0 }).every((c) => c.tone === 'neutral')).toBe(true);
  });

  it('trạng thái kết nối: một dòng mỗi dịch vụ, Facebook → /social, bỏ dòng không phải dịch vụ', () => {
    const lines = connectionLines(BOSS.rows);
    expect(lines.map((l) => l.key)).toEqual(['hub', 'facebook', 'agy', 'jev']);
    expect(lines[0]).toMatchObject({ state: 'ok', text: 'Đã kết nối', to: '/guide/viec-sep' });
    expect(lines[1]).toMatchObject({ state: 'todo', text: 'Chưa kết nối', to: '/social' });
    expect(lines[3]).toMatchObject({ state: 'optional', text: 'Chưa bật (tuỳ chọn)' });
    expect(connectionLines(undefined)).toEqual([]);
  });

  it('hợp đồng: chỉ GET, kèm query list/limit', async () => {
    const seen: Array<{ path: string; opts: Record<string, unknown> }> = [];
    const r = vi.fn(async (path: string, opts: Record<string, unknown> = {}) => {
      seen.push({ path, opts });
      return {} as never;
    });
    const api = ownerEndpoints(r as never);
    await api.today();
    await api.relations('cooling', 30);
    await api.tasks();
    expect(seen.map((s) => s.path)).toEqual(['/owner/today', '/owner/relations', '/owner/tasks']);
    expect(seen[1].opts.query).toEqual({ list: 'cooling', limit: 30 });
    expect(seen.every((s) => s.opts.method === undefined)).toBe(true);
    const src = readFileSync(resolve(__dirname, '../../../../packages/contracts/src/owner.ts'), 'utf8');
    expect(src).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/);
    expect(src).not.toContain("from './defaults'");
  });

  it('mock-owner khớp hợp đồng: 403 vai khác, 422 list lạ, limit bị chặn, kịch bản rỗng/lỗi', () => {
    const m = createOwnerMock({ fresh: false, emit: () => undefined });
    expect(callMock(m, '/api/v1/owner/today', 'operator')).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(callMock(m, '/api/v1/owner/relations?list=zzz')).toMatchObject({ status: 422, body: { code: 'VALIDATION' } });
    expect(callMock(m, '/api/v1/owner/today', 'owner', 'POST')?.status).toBe(405);
    const rel = callMock(m, '/api/v1/owner/relations?list=hot&limit=2')?.body as { items: unknown[] };
    expect(rel.items).toHaveLength(2);
    expect((callMock(m, '/api/v1/owner/relations?list=hot&limit=900')?.body as { items: unknown[] }).items).toHaveLength(3);
    m.hooks.scenario?.({ mode: 'empty' } as never);
    expect(callMock(m, '/api/v1/owner/tasks')?.body).toMatchObject({ groups: [{ count: 0, items: [] }, { count: 0 }, { count: 0 }] });
    m.hooks.scenario?.({ mode: 'error', only: 'today' } as never);
    expect(callMock(m, '/api/v1/owner/today')?.status).toBe(500);
    expect(callMock(m, '/api/v1/owner/tasks')?.status).toBe(200);
    expect((m.hooks.state?.() as { nonOwnerCalls: string[] }).nonOwnerCalls).toEqual(['operator GET /owner/today']);
  });
});

// ── 5 màn × (tải, rỗng, lỗi, có dữ liệu) ───────────────────────────────────────────────────────────────────────────

describe('Hôm nay (/owner)', () => {
  it('đang tải: khung chờ, chưa có chữ lỗi', async () => {
    server.mode = 'hang';
    mountScreen(<TodayScreen />);
    expect(await screen.findByTestId('owner-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('owner-error')).not.toBeInTheDocument();
  });

  it('có dữ liệu: Cần Sếp duyệt, 4 số, bản tin, câu "Gen lọc giúp", gợi ý, tiến độ — chữ đời thường', async () => {
    mountScreen(<TodayScreen />);
    const review = await screen.findByTestId('owner-review');
    const rows = within(review).getAllByTestId('owner-review-row');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('Gen đề xuất: Soạn nháp tin gửi đi (cần mã PIN)');
    expect(rows[1]).toHaveAttribute('href', '/workbench?id=draft-1');
    expect(rows[3]).toHaveAttribute('href', '/tasks?overdue=true');
    expect(screen.getByTestId('owner-review-count')).toHaveTextContent('4');
    const kpis = screen.getByTestId('owner-kpis');
    expect(within(kpis).getByTestId('owner-kpi-hot')).toHaveTextContent('Khách nóng');
    expect(within(kpis).getByTestId('owner-kpi-hot')).toHaveTextContent('3');
    expect(within(kpis).getByTestId('owner-kpi-hot')).toHaveAttribute('href', '/owner/quan-he?list=hot');
    expect(within(kpis).getByTestId('owner-kpi-open_opps')).toHaveTextContent('2,4 tỷ ₫');
    expect(screen.getByTestId('owner-briefing')).toHaveTextContent('3 bản nháp chờ Sếp duyệt');
    expect(screen.getByRole('link', { name: /Mở bản tin/ })).toHaveAttribute('href', '/owner/gen');
    expect(screen.getByTestId('owner-filter-value')).toHaveTextContent('Tuần này Gen lọc giúp Sếp 128 tin rác/trùng, bớt 94 lượt gọi AI.');
    const apply = screen.getByTestId('owner-suggest-apply_standard');
    expect(within(apply).getByRole('link', { name: 'Mở' })).toHaveAttribute('href', '/system?tab=brain#chuan');
    const bg = screen.getByTestId('owner-suggest-background_key_missing');
    expect(within(bg).getByRole('link', { name: 'Mở' })).toHaveAttribute('href', '/system?tab=brain');
    expect(screen.getByTestId('owner-progress')).toHaveTextContent('Việc Sếp cần làm: 1/6 việc bắt buộc đã xong');
    // Chữ đời thường: không có thuật ngữ kỹ thuật ở Hôm nay.
    expect(screen.getByTestId('owner-today').textContent ?? '').not.toMatch(/\b(model|token|API)\b/i);
    noRawObjects();
  });

  it('rỗng: nói đời thường, không có thẻ bản tin/gợi ý/câu lọc', async () => {
    server.mode = 'empty';
    mountScreen(<TodayScreen />);
    expect(await screen.findByText('Chưa có gì chờ Sếp duyệt')).toBeInTheDocument();
    expect(screen.queryByTestId('owner-briefing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('owner-filter-value')).not.toBeInTheDocument();
    expect(screen.queryByTestId('owner-suggestions')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('owner-kpis')).getByTestId('owner-kpi-hot')).toHaveTextContent('0');
    noRawObjects();
  });

  it('lỗi: câu thân thiện + "Chi tiết kỹ thuật" (chuỗi) + Thử lại; thử lại được', async () => {
    server.mode = 'error';
    mountScreen(<TodayScreen />);
    const err = await screen.findByTestId('owner-error');
    expect(err).toHaveTextContent('Chi tiết kỹ thuật');
    expect(err).toHaveTextContent('HTTP 500');
    expect(err.querySelector('details code')?.textContent).toContain('INTERNAL');
    noRawObjects();
    server.mode = 'data';
    await userEvent.click(within(err).getByRole('button', { name: /Thử lại/ }));
    expect(await screen.findByTestId('owner-review')).toBeInTheDocument();
  });

  it('máy chủ trả link lạ/giá trị lạ: không vỡ, không dẫn ra ngoài', async () => {
    const real = server.mock.handle;
    server.mock = { ...server.mock, handle: (ctx: P2Ctx) => {
      if (ctx.path === '/owner/today') {
        return ctx.reply(200, {
          needs_review: [{ kind: 'draft', title: { x: 1 }, to: 'https://evil.example', at: 'không phải giờ' }, { kind: '???', title: 'Việc lạ', to: '//evil', at: null }],
          kpis: { hot: 'x', cooling: null, open_opps: 0, open_value_vnd: 0, overdue_promises: 0 },
          briefing_latest: null, filter_value: null, suggestions: [{ key: 'apply_standard', title: 'T', body: { b: 1 }, to: 'javascript:alert(1)' }],
          progress: { required_done: 'a', required_total: 'b' },
        });
      }
      return real(ctx);
    } } as never;
    mountScreen(<TodayScreen />);
    const rows = await screen.findAllByTestId('owner-review-row');
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.getAttribute('href')).toBe('/owner');
    expect(screen.getByTestId('owner-suggest-apply_standard').querySelector('a')).toHaveAttribute('href', '/owner');
    noRawObjects();
  });
});

describe('Quan hệ (/owner/quan-he)', () => {
  it('đang tải', async () => {
    server.mode = 'hang';
    mountScreen(<RelationsScreen />, '/owner/quan-he');
    expect(await screen.findByTestId('owner-loading')).toBeInTheDocument();
  });

  it('4 danh sách; bấm dòng mở Hồ sơ sống; ?list= chọn danh sách', async () => {
    const router = mountScreen(<RelationsScreen />, '/owner/quan-he');
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    const rows = await screen.findAllByTestId('owner-rel-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Trần Văn Hậu');
    expect(rows[0]).toHaveTextContent('Khách hàng · Xưởng gỗ Bình Dương');
    expect(rows[0]).toHaveTextContent('Độ nóng 91 · đang tăng');
    expect(rows[0]).toHaveAttribute('href', '/profile?id=p-hau');
    for (const [list, first] of [['cooling', 'Hoàng Thị Lan và Phạm Quốc Minh'], ['bridges', 'Trần Minh Khoa'], ['matches', 'Ván MDF E1 17mm']] as const) {
      await userEvent.click(screen.getByTestId(`owner-rel-tab-${list}`));
      await waitFor(() => expect(screen.getByTestId('owner-rel-panel')).toHaveAttribute('data-list', list));
      expect((await screen.findAllByTestId('owner-rel-row'))[0]).toHaveTextContent(first);
      expect(router.state.location.search).toBe(`?list=${list}`);
    }
    await userEvent.click(screen.getByTestId('owner-rel-tab-hot'));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    noRawObjects();
  });

  it('?list=cooling mở thẳng danh sách nguội; list lạ rơi về khách nóng', async () => {
    mountScreen(<RelationsScreen />, '/owner/quan-he?list=cooling');
    expect(await screen.findByText('42 ngày chưa liên lạc')).toBeInTheDocument();
    expect(screen.getByTestId('owner-rel-tab-cooling')).toHaveAttribute('aria-selected', 'true');
    expect(server.calls.some((u) => u.includes('list=cooling'))).toBe(true);
  });

  it('?list= lạ rơi về khách nóng', async () => {
    mountScreen(<RelationsScreen />, '/owner/quan-he?list=bậy');
    expect(await screen.findAllByTestId('owner-rel-row')).toHaveLength(3);
    expect(screen.getByTestId('owner-rel-tab-hot')).toHaveAttribute('aria-selected', 'true');
  });

  it('rỗng: chữ đời thường theo từng danh sách', async () => {
    server.mode = 'empty';
    mountScreen(<RelationsScreen />, '/owner/quan-he');
    expect(await screen.findByText('Chưa có khách nóng')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('owner-rel-tab-matches'));
    expect(await screen.findByText('Chưa có cặp nào hợp nhau')).toBeInTheDocument();
    noRawObjects();
  });

  it('lỗi: có "Chi tiết kỹ thuật"', async () => {
    server.mode = 'error';
    mountScreen(<RelationsScreen />, '/owner/quan-he');
    const err = await screen.findByTestId('owner-error');
    expect(err).toHaveTextContent('Chi tiết kỹ thuật');
    noRawObjects();
  });

  it('không có thuật ngữ kỹ thuật ở Quan hệ', async () => {
    mountScreen(<RelationsScreen />, '/owner/quan-he');
    await screen.findAllByTestId('owner-rel-row');
    expect(screen.getByTestId('owner-relations').textContent ?? '').not.toMatch(/\b(model|token|API)\b/i);
  });
});

describe('Việc (/owner/viec)', () => {
  it('đang tải', async () => {
    server.mode = 'hang';
    mountScreen(<OwnerTasksScreen />, '/owner/viec');
    expect(await screen.findByTestId('owner-loading')).toBeInTheDocument();
  });

  it('có dữ liệu: 3 nhóm, đếm + dòng mẫu + link sâu', async () => {
    mountScreen(<OwnerTasksScreen />, '/owner/viec');
    const inbox = await screen.findByTestId('owner-group-inbox');
    expect(screen.getByTestId('owner-group-count-inbox')).toHaveTextContent('7');
    expect(within(inbox).getAllByTestId('owner-task-row')).toHaveLength(2);
    expect(screen.getByTestId('owner-group-open-inbox')).toHaveAttribute('href', '/inbox');
    expect(screen.getByTestId('owner-group-open-desk')).toHaveAttribute('href', '/workbench');
    expect(screen.getByTestId('owner-group-open-tasks')).toHaveAttribute('href', '/tasks');
    expect(screen.getByText('Hộp thư đã lọc')).toBeInTheDocument();
    expect(screen.getByText('Bàn làm việc')).toBeInTheDocument();
    expect(screen.getByText('Việc & Nhắc hẹn')).toBeInTheDocument();
    noRawObjects();
  });

  it('rỗng: một câu chung, không ba hộp rỗng', async () => {
    server.mode = 'empty';
    mountScreen(<OwnerTasksScreen />, '/owner/viec');
    expect(await screen.findByText('Chưa có việc nào')).toBeInTheDocument();
    expect(screen.queryByTestId('owner-group-inbox')).not.toBeInTheDocument();
  });

  it('lỗi: có "Chi tiết kỹ thuật"', async () => {
    server.mode = 'error';
    mountScreen(<OwnerTasksScreen />, '/owner/viec');
    expect(await screen.findByTestId('owner-error')).toHaveTextContent('Chi tiết kỹ thuật');
    noRawObjects();
  });
});

describe('Hỏi Gen (/owner/gen)', () => {
  it('đang tải (chưa biết người dùng)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    mountScreen(<AskGenScreen />, '/owner/gen');
    expect(await screen.findByTestId('owner-loading')).toBeInTheDocument();
  });

  it('có dữ liệu: nhúng khung chat Gen; câu gợi ý chỉ điền sẵn ô nhập', async () => {
    mountScreen(<AskGenScreen />, '/owner/gen');
    const panel = await screen.findByTestId('owner-gen-panel');
    expect(within(panel).getByLabelText('Gen — trợ lý quản trị')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Câu hỏi cho Gen')).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('complementary', { name: 'Gợi ý câu hỏi' })).getByRole('button', { name: /Khách nào hỏi giá hôm nay/ }));
    await waitFor(() => expect(within(panel).getByLabelText('Câu hỏi cho Gen')).toHaveValue('Khách nào hỏi giá hôm nay?'));
    expect(useGenStore.getState().messages).toHaveLength(0);                 // chỉ điền sẵn, không gửi
    expect(server.calls.some((u) => u.includes('/gen/ask') || u.includes('/gen/turns'))).toBe(false);
  });

  it('rỗng: Gen tắt ⇒ giải thích + link Bộ não AI', async () => {
    server.me = ME({ features: { gen: false } });
    mountScreen(<AskGenScreen />, '/owner/gen');
    expect(await screen.findByText('Gen đang tắt')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mở Bộ não AI' })).toHaveAttribute('href', '/system?tab=brain');
    expect(screen.queryByTestId('owner-gen-panel')).not.toBeInTheDocument();
  });

  it('lỗi: không tải được tài khoản ⇒ "Chi tiết kỹ thuật"', async () => {
    server.meFails = true;
    mountScreen(<AskGenScreen />, '/owner/gen');
    expect(await screen.findByTestId('owner-error')).toHaveTextContent('Chi tiết kỹ thuật');
    noRawObjects();
  });
});

describe('Thêm (/owner/them)', () => {
  it('đang tải trạng thái kết nối', async () => {
    server.bossMode = 'hang';
    mountScreen(<MoreScreen />, '/owner/them');
    expect(await screen.findByTestId('owner-loading')).toBeInTheDocument();
  });

  it('có dữ liệu: một dòng mỗi dịch vụ, Facebook → /social, Cài đặt nâng cao → /overview (không phải "/")', async () => {
    mountScreen(<MoreScreen />, '/owner/them');
    const rows = await screen.findAllByTestId('owner-conn-row');
    expect(rows.map((r) => r.querySelector('.owner-row__title')?.textContent)).toEqual(['Gen-hub', 'Facebook', 'Google / Antigravity', 'Jev']);
    expect(rows[0]).toHaveTextContent('Đã kết nối');
    expect(rows[1]).toHaveTextContent('Chưa kết nối');
    expect(rows[1]).toHaveAttribute('href', '/social');
    expect(rows[2]).toHaveAttribute('href', '/guide/viec-sep');
    const adv = screen.getByTestId('owner-advanced');
    expect(adv).toHaveAttribute('href', ADVANCED_SETTINGS_PATH);
    expect(adv.getAttribute('href')).toBe('/overview');
    expect(adv.getAttribute('href')).not.toBe('/');
    noRawObjects();
  });

  it('rỗng: chưa có dịch vụ nào', async () => {
    server.bossMode = 'empty';
    mountScreen(<MoreScreen />, '/owner/them');
    expect(await screen.findByText('Chưa có dịch vụ nào để hiện')).toBeInTheDocument();
    expect(screen.getByTestId('owner-advanced')).toBeInTheDocument();       // lối vào Cài đặt nâng cao luôn có
  });

  it('lỗi: có "Chi tiết kỹ thuật", vẫn còn Cài đặt nâng cao', async () => {
    server.bossMode = 'error';
    mountScreen(<MoreScreen />, '/owner/them');
    expect(await screen.findByTestId('owner-error')).toHaveTextContent('Chi tiết kỹ thuật');
    expect(screen.getByTestId('owner-advanced')).toBeInTheDocument();
    noRawObjects();
  });
});

// ── khung ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('OwnerShell', () => {
  it('máy tính: thanh trái 6 mục, Phân tích "sắp có" bị khoá, không có thanh dưới', async () => {
    mountShell('/owner');
    const rail = await screen.findByRole('navigation', { name: 'Mặt tiền' });
    expect(within(rail).getAllByRole('link')).toHaveLength(5);
    const soon = within(rail).getByRole('button', { name: /Phân tích/ });
    expect(soon).toBeDisabled();
    expect(soon).toHaveTextContent('sắp có');
    expect(within(rail).getByTestId('owner-nav-today')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('navigation', { name: 'Thanh dưới' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hôm nay');
  });

  it('< 760px: thanh dưới đúng 5 nút, không có thanh trái; bấm chuyển màn', async () => {
    setViewport(true);
    const router = mountShell('/owner');
    const bar = await screen.findByRole('navigation', { name: 'Thanh dưới' });
    const items = within(bar).getAllByRole('link');
    expect(items).toHaveLength(5);
    expect(items.map((i) => i.textContent)).toEqual(['Hôm nay', 'Việc', 'Quan hệ', 'Hỏi Gen', 'Thêm']);
    expect(screen.queryByRole('navigation', { name: 'Mặt tiền' })).not.toBeInTheDocument();
    await userEvent.click(within(bar).getByTestId('owner-tabbar-relations'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/owner/quan-he'));
    expect(within(bar).getByTestId('owner-tabbar-relations')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Quan hệ');
  });

  it('vai khác Owner mở /owner/* ⇒ chuyển "/"', async () => {
    server.me = ME({}, 'operator');
    const router = mountShell('/owner/quan-he');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(server.calls.some((u) => u.includes('/owner/'))).toBe(false);          // không gọi API Owner
  });

  it('mật khẩu tạm ⇒ /change-password', async () => {
    server.me = ME({ must_change_password: true });
    const router = mountShell('/owner');
    await waitFor(() => expect(router.state.location.pathname).toBe('/change-password'));
  });

  it('không tải được tài khoản ⇒ lỗi thân thiện + Chi tiết kỹ thuật', async () => {
    server.meFails = true;
    mountShell('/owner');
    expect(await screen.findByTestId('owner-shell-error')).toHaveTextContent('Chi tiết kỹ thuật');
  });

  it('?gen=coach: Gen bật ⇒ về Hôm nay (/owner) và đặt cờ thẻ Hôm nay của Sếp; Gen tắt ⇒ /guide/viec-sep', async () => {
    const router = mountShell('/owner/viec?gen=coach');
    await waitFor(() => expect(router.state.location.pathname).toBe('/owner'));
    expect(router.state.location.search).toBe('');
    expect(useGenStore.getState().coachFocus).toBe(true);
  });

  it('?gen=coach với Gen tắt ⇒ /guide/viec-sep như hiện nay', async () => {
    server.me = ME({ features: { gen: false } });
    const router = mountShell('/owner?gen=coach');
    await waitFor(() => expect(router.state.location.pathname).toBe('/guide/viec-sep'));
  });

  it('?gen=<mã hội thoại> (Bản tin từ chuông) ⇒ mở Hỏi Gen', async () => {
    const router = mountShell('/owner?gen=0192aaaa-bbbb-4ccc-8ddd-eeeeffff0000');
    await waitFor(() => expect(router.state.location.pathname).toBe('/owner/gen'));
    expect(router.state.location.search).toBe('');
  });
});

describe('BackToFront ("← Về Mặt tiền")', () => {
  it('Owner thấy, bấm về /owner', async () => {
    const router = mountScreen(<><BackToFront /><Where /></>, '/overview');
    const link = await screen.findByTestId('back-to-front');
    expect(link).toHaveAccessibleName('Về Mặt tiền');
    expect(link).toHaveTextContent('← Về Mặt tiền');
    await userEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe('/owner'));
  });

  it('vai khác Owner không thấy', async () => {
    server.me = ME({}, 'manager');
    mountScreen(<><BackToFront /><Where /></>, '/overview');
    await waitFor(() => expect(server.calls.some((u) => u.includes('/auth/me'))).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('back-to-front')).not.toBeInTheDocument();
  });
});

describe('biểu tượng', () => {
  it('mọi icon Mặt tiền dùng đều có trong bảng icon của @gen-harness/ui (tên lạ vẽ ra ô trống)', () => {
    const dir = resolve(__dirname, '../../src/owner');
    const names = new Set<string>();
    for (const f of readdirSync(dir)) {
      if (!/\.tsx?$/.test(f)) continue;
      for (const m of readFileSync(resolve(dir, f), 'utf8').matchAll(/['"`](ph(?:-fill)? ph-[a-z0-9-]+)['"`]/g)) names.add(m[1]);
    }
    expect(names.size).toBeGreaterThan(15);
    expect([...names].filter((n) => !hasIcon(n))).toEqual([]);
  });
});

describe('cụm route', () => {
  it('/owner khai báo tay ngoài screens.json, đặt trước "/" (AppShell), có đủ 5 con + đường lạ về Hôm nay', () => {
    const root = routes[0].children ?? [];
    const idxOwner = root.findIndex((r) => r.path === '/owner');
    const idxHome = root.findIndex((r) => r.path === '/');
    expect(idxOwner).toBeGreaterThanOrEqual(0);
    expect(idxOwner).toBeLessThan(idxHome);
    const kids = root[idxOwner].children ?? [];
    expect(kids.map((k) => (k.index ? 'index' : k.path))).toEqual(['index', 'quan-he', 'viec', 'gen', 'them', '*']);
    const consolePaths = (root[idxHome].children ?? []).map((c) => c.path);
    expect(consolePaths).not.toContain('owner');
    expect(consolePaths.at(-1)).toBe('*');
  });
});
