/**
 * v0.1.35 (F-1): ô chọn người / trợ lý THẬT — hook dùng chung (`src/lib/pickers.ts`) + 3 hộp thoại giao/gán gửi
 * đúng id lấy từ `/pickers/users` / `/pickers/agents` (không còn danh sách cứng 'u-…' / 'agent-…').
 */
import type { ReactElement, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { CaseItem, DirChannel, DirCursorPage, DirGroup, InboxPage } from '@gen-harness/contracts';
import { InboxScreen } from '../../src/screens/queue/InboxScreen';
import { DealsScreen } from '../../src/screens/market/DealsScreen';
import { DirectoryScreen } from '../../src/screens/relations/DirectoryScreen';
import { queryClient } from '../../src/lib/queryClient';
import { errorText } from '../../src/lib/errorText';
import {
  EMPTY_AGENTS_TEXT,
  EMPTY_AGENTS_TEXT_ASK,
  EMPTY_USERS_TEXT,
  EMPTY_USERS_TEXT_ASK,
  useAgentOptions,
  useAssignees,
} from '../../src/lib/pickers';
import { qk } from '../../src/lib/queries';
import { useUrlStateStore } from '../../src/lib/uiStore';
import { AGENT_IDS, USER_IDS } from '../mock-ids';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const problem = (status: number, code: string, title: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ type: `https://gen-harness.local/errors/${code.toLowerCase()}`, title, status, code, detail: null, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });

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

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

/** Đặt /auth/me với bảng quyền cho trước (gợi ý khi rỗng phụ thuộc quyền mời người / tạo agent). */
function meWith(permissions: Record<string, string>) {
  const me = {
    id: USER_IDS.owner, email: 'x@genesis.local', display_name: 'X', role: { code: 'custom', name: 'Tuỳ biến' },
    org: { id: 'o', name: 'x', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
    addressing: { self: 'Anh', bot_calls_me: 'Sếp' }, pin_verified_until: null, permissions,
  };
  queryClient.setQueryData(qk.me, me);
  return me;
}

function renderScreen(ui: ReactElement) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
  useUrlStateStore.setState({ params: {} });
});

const USERS = {
  items: [
    { id: USER_IDS.minh, name: 'Anh Minh Kiểm', me: false },
    { id: USER_IDS.owner, name: 'Anh Cơ La (Ryan)', me: true },
    { id: USER_IDS.lan, name: 'Chị Lan Phạm', me: false },
  ],
};
const AGENTS = {
  items: [
    { id: AGENT_IDS.hc, name: 'Admin hậu cần' },
    { id: AGENT_IDS.tls, name: 'Trợ lý thương mại' },
  ],
};

describe('hook dùng chung', () => {
  it('useAssignees: người đang đăng nhập là "Tôi" và đứng đầu, người khác giữ tên', async () => {
    mockFetch((c) => (c.url.includes('/pickers/users') ? json(200, USERS) : json(404)));
    const { result } = renderHook(() => useAssignees(), { wrapper });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.options).toEqual([
      { id: USER_IDS.owner, label: 'Tôi' },
      { id: USER_IDS.minh, label: 'Anh Minh Kiểm' },
      { id: USER_IDS.lan, label: 'Chị Lan Phạm' },
    ]);
    expect(result.current.hasOthers).toBe(true);
  });

  it('useAgentOptions đọc /pickers/agents', async () => {
    const calls = mockFetch((c) => (c.url.includes('/pickers/agents') ? json(200, AGENTS) : json(404)));
    const { result } = renderHook(() => useAgentOptions(), { wrapper });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(calls.some((c) => c.url.endsWith('/api/v1/pickers/agents'))).toBe(true);
    expect(result.current.options).toEqual([
      { id: AGENT_IDS.hc, label: 'Admin hậu cần' },
      { id: AGENT_IDS.tls, label: 'Trợ lý thương mại' },
    ]);
  });

  it('lỗi 403 → errorText là chuỗi thân thiện, không fallback danh sách cứng', async () => {
    mockFetch(() => problem(403, 'FORBIDDEN', 'Vai trò của bạn không có quyền thao tác này'));
    const { result } = renderHook(() => useAgentOptions(), { wrapper });
    await waitFor(() => expect(result.current.query.isError).toBe(true));
    expect(result.current.options).toEqual([]);
    const text = errorText(result.current.query.error);
    expect(typeof text).toBe('string');
    expect(text).toBe('Vai trò của bạn không có quyền làm thao tác này.');
  });
});

const INBOX: InboxPage = {
  items: [
    {
      id: 'iq-1', code: 'OPP-1842', item_type: 'unit', tab: 'opportunity', title: 'AskedPrice',
      summary: 'Xưởng gỗ Bình Dương hỏi giá 3 container MDF.', priority: 'P1', created_at: '2026-09-24T02:00:00Z',
      score: 0.91, confidence_band: 'cao', subject: null, group: null, agent: null,
      alert_type: null, alert_type_label: null, suggested_action: null,
    },
  ],
  next_cursor: null,
  total: 1,
  counts: { all: 1, opportunity: 1, alert: 0, approval: 0, reply: 0, candidate: 0 },
};

describe('Hộp thư ý nghĩa › Giao cho người khác', () => {
  it('gửi user_id lấy từ /pickers/users', async () => {
    const calls = mockFetch((c) => {
      if (c.url.includes('/pickers/users')) return json(200, USERS);
      if (c.method === 'POST' && c.url.includes('/inbox/iq-1/assign')) return json(200, { ok: true, assigned_to: { id: USER_IDS.lan, name: 'Chị Lan Phạm' } });
      if (c.url.includes('/inbox')) return json(200, INBOX);
      return json(404);
    });
    const user = userEvent.setup();
    renderScreen(<InboxScreen />);
    await screen.findByText(/Xưởng gỗ Bình Dương hỏi giá/);
    await user.click(screen.getByRole('button', { name: 'Giao cho người khác' }));
    const dlg = await screen.findByRole('dialog', { name: 'Giao cho người khác' });
    await within(dlg).findByText('Chị Lan Phạm');
    const names = within(within(dlg).getByRole('list')).getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(['Tôi', 'Anh Minh Kiểm', 'Chị Lan Phạm']);
    await user.click(within(dlg).getByText('Chị Lan Phạm'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.includes('/inbox/iq-1/assign'))).toBe(true));
    const call = calls.find((c) => c.method === 'POST' && c.url.includes('/inbox/iq-1/assign'))!;
    expect(call.body).toEqual({ user_id: USER_IDS.lan });
  });

  it('lỗi tải danh sách hiện chuỗi thân thiện (không render object)', async () => {
    mockFetch((c) => {
      if (c.url.includes('/pickers/users')) return problem(503, 'DB_UNAVAILABLE', 'Cơ sở dữ liệu đang không phản hồi');
      if (c.url.includes('/inbox')) return json(200, INBOX);
      return json(404);
    });
    const user = userEvent.setup();
    renderScreen(<InboxScreen />);
    await screen.findByText(/Xưởng gỗ Bình Dương hỏi giá/);
    await user.click(screen.getByRole('button', { name: 'Giao cho người khác' }));
    const dlg = await screen.findByRole('dialog', { name: 'Giao cho người khác' });
    const alert = await within(dlg).findByRole('alert', {}, { timeout: 8000 });
    expect(alert.textContent).toMatch(/Cơ sở dữ liệu/);
    expect(alert.textContent).not.toContain('[object Object]');
  });

  it.each([
    ['có roles.manage → chỉ đường Điều khiển hệ thống › Người dùng', { 'queue.act': 'all', 'roles.manage': 'all' }, EMPTY_USERS_TEXT],
    ['operator (không roles.manage) → nhờ Owner mời', { 'queue.act': 'team' }, EMPTY_USERS_TEXT_ASK],
  ])('chỉ có người đang đăng nhập → "Tôi" + gợi ý: %s', async (_name, perms, text) => {
    const me = meWith(perms);
    mockFetch((c) => {
      if (c.url.includes('/auth/me')) return json(200, me);
      if (c.url.includes('/pickers/users')) return json(200, { items: [{ id: USER_IDS.owner, name: 'Anh Cơ La (Ryan)', me: true }] });
      if (c.url.includes('/inbox')) return json(200, INBOX);
      return json(404);
    });
    const user = userEvent.setup();
    renderScreen(<InboxScreen />);
    await screen.findByText(/Xưởng gỗ Bình Dương hỏi giá/);
    await user.click(screen.getByRole('button', { name: 'Giao cho người khác' }));
    const dlg = await screen.findByRole('dialog', { name: 'Giao cho người khác' });
    expect(await within(dlg).findByText(text)).toBeInTheDocument();
    expect(within(dlg).getByText('Tôi')).toBeInTheDocument();
  });
});

const CASE: CaseItem = {
  id: 'case-1', code: 'CAS-0018', kind: 'complaint', priority: 'P1', title: 'Khách phàn nàn giao trễ', status: 'open',
  assignee: null, subject: null, opened_at: '2026-09-24T00:00:00Z', resolved_at: null, updated_at: '2026-09-24T00:00:00Z',
};

describe('Deal & Vụ việc › Gán người xử lý', () => {
  it('gửi assignee_user_id lấy từ /pickers/users, giữ nút "Chưa gán"', async () => {
    const calls = mockFetch((c) => {
      if (c.url.includes('/pickers/users')) return json(200, USERS);
      if (c.method === 'PATCH' && c.url.includes('/cases/case-1')) return json(200, { ...CASE, assignee: { id: USER_IDS.lan, name: 'Chị Lan Phạm' } });
      if (c.url.includes('/cases')) return json(200, { items: [CASE], next_cursor: null, total: 1 });
      if (c.url.includes('/deals')) return json(200, { items: [], next_cursor: null, total: 0 });
      if (c.url.includes('/opportunities')) return json(200, { items: [], next_cursor: null, total: 0 });
      return json(404);
    });
    useUrlStateStore.setState({ params: { dtab: 'cases' } });
    const user = userEvent.setup();
    renderScreen(<DealsScreen />);
    const row = (await screen.findByText('CAS-0018')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Đổi' }));
    const dlg = await screen.findByRole('dialog', { name: 'Gán người xử lý' });
    expect(within(dlg).getByText('Chưa gán')).toBeInTheDocument();
    await user.click(await within(dlg).findByText('Chị Lan Phạm'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.url.includes('/cases/case-1'))).toBe(true));
    const call = calls.find((c) => c.method === 'PATCH' && c.url.includes('/cases/case-1'))!;
    expect(call.body).toEqual({ assignee_user_id: USER_IDS.lan });
  });

  it('người đang được gán đã bị khoá (không có trong /pickers/users) → dòng "(đã khoá)" được đánh dấu chọn', async () => {
    const LOCKED = { ...CASE, assignee: { id: '0199a000-0000-7000-8000-00000000dead', name: 'Anh Tùng' } };
    mockFetch((c) => {
      if (c.url.includes('/pickers/users')) return json(200, USERS);
      if (c.url.includes('/cases')) return json(200, { items: [LOCKED], next_cursor: null, total: 1 });
      if (c.url.includes('/deals')) return json(200, { items: [], next_cursor: null, total: 0 });
      if (c.url.includes('/opportunities')) return json(200, { items: [], next_cursor: null, total: 0 });
      return json(404);
    });
    useUrlStateStore.setState({ params: { dtab: 'cases' } });
    const user = userEvent.setup();
    renderScreen(<DealsScreen />);
    const row = (await screen.findByText('CAS-0018')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Đổi' }));
    const dlg = await screen.findByRole('dialog', { name: 'Gán người xử lý' });
    const locked = (await within(dlg).findByText('Anh Tùng (đã khoá)')).closest('button') as HTMLElement;
    expect(locked).toHaveAttribute('aria-pressed', 'true');
    expect(within(dlg).getByText('Chưa gán').closest('button')).toHaveAttribute('aria-pressed', 'false');
    expect(within(dlg).getByText('Chị Lan Phạm').closest('button')).toHaveAttribute('aria-pressed', 'false');
  });
});

const CHANNELS: DirChannel[] = [{ id: 'ch-zalo', type: 'zalo', name: 'Zalo', state: 'active', group_count: 1, events_24h: 412 }];
const GROUPS: DirCursorPage<DirGroup> = {
  items: [
    {
      id: 'g1', code: 'GRP-ZL-0114', name: 'Vận hành Genesis — Quý 4', kind: 'internal', listen_mode: 'tagged_only',
      member_count: 24, events_24h: 412, heat: 87, channel: { type: 'zalo', name: 'Zalo' },
      bot: { id: AGENT_IDS.ka, name: 'Key Account junior' }, created_at: '2026-09-01T00:00:00Z',
    },
  ],
  next_cursor: null,
  total: 1,
};

describe('Nhóm & Con người › Gán BOT trực nhóm', () => {
  it('gửi agent_id lấy từ /pickers/agents; BOT hiện tại đã tắt vẫn hiện "(đã tắt)" và được chọn', async () => {
    const calls = mockFetch((c) => {
      if (c.url.includes('/pickers/agents')) return json(200, AGENTS);
      if (c.url.includes('/directory/channels')) return json(200, CHANNELS);
      if (c.method === 'POST' && c.url.includes('/directory/groups/g1/bot')) return json(200, { ok: true });
      if (c.url.includes('/directory/groups')) return json(200, GROUPS);
      return json(404);
    });
    const user = userEvent.setup();
    renderScreen(<DirectoryScreen />);
    const row = (await screen.findByText('GRP-ZL-0114')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /Đổi|Gán/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Gán BOT trực nhóm' });
    const stale = (await within(dlg).findByText('Key Account junior (đã tắt)')).closest('button')!;
    expect(stale).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(dlg).getByText('Admin hậu cần'));
    await user.click(within(dlg).getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.includes('/directory/groups/g1/bot'))).toBe(true));
    const call = calls.find((c) => c.method === 'POST' && c.url.includes('/directory/groups/g1/bot'))!;
    expect(call.body).toEqual({ agent_id: AGENT_IDS.hc });
  });

  it.each([
    ['có system.manage → chỉ đường Agent & Model › Danh tính Agent', { 'profile.write': 'all', 'system.manage': 'all' }, EMPTY_AGENTS_TEXT],
    ['không system.manage → nhờ Owner tạo', { 'profile.write': 'team' }, EMPTY_AGENTS_TEXT_ASK],
  ])('không có trợ lý nào đang bật → %s', async (_name, perms, text) => {
    const me = meWith(perms);
    mockFetch((c) => {
      if (c.url.includes('/auth/me')) return json(200, me);
      if (c.url.includes('/pickers/agents')) return json(200, { items: [] });
      if (c.url.includes('/directory/channels')) return json(200, CHANNELS);
      if (c.url.includes('/directory/groups')) return json(200, { ...GROUPS, items: [{ ...GROUPS.items[0], bot: null }] });
      return json(404);
    });
    const user = userEvent.setup();
    renderScreen(<DirectoryScreen />);
    const row = (await screen.findByText('GRP-ZL-0114')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /Đổi|Gán/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Gán BOT trực nhóm' });
    expect(await within(dlg).findByText(text)).toBeInTheDocument();
  });
});
