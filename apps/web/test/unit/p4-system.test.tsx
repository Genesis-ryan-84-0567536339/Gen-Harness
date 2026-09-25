import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Boundary, PermissionsPage, PermScope, RetentionPolicy } from '@gen-harness/contracts';
import { SystemScreen } from '../../src/screens/system/SystemScreen';
import { qk } from '../../src/lib/queries';
import { useUrlStateStore } from '../../src/lib/uiStore';

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

function meWith(permissions: Record<string, string>) {
  return {
    id: 'u', email: 'owner@genesis.local', display_name: 'Anh Cơ La (Ryan)',
    role: { code: 'owner', name: 'Owner — Sếp' },
    org: { id: 'o', name: 'x', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
    addressing: { self: 'Anh', bot_calls_me: 'Sếp' }, pin_verified_until: null,
    permissions,
  };
}
const FULL_PERMS = { 'system.read': 'all', 'system.manage': 'all', 'roles.manage': 'all', 'audit.read': 'all', 'data.manage': 'all' };

function renderScreen(ui: ReactElement, permissions: Record<string, string> = FULL_PERMS, tab = 'channels') {
  useUrlStateStore.setState({ params: { tab } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.me, meWith(permissions));
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useUrlStateStore.setState({ params: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const PERMISSIONS_PAGE: PermissionsPage = {
  columns: [
    { key: 'overview', label: 'Tổng quan', permissions: ['overview.read'] },
    { key: 'queue', label: 'Hàng đợi', permissions: ['queue.read', 'queue.act'] },
    { key: 'profile', label: 'Hồ sơ khách', permissions: ['profile.read', 'profile.write'] },
    { key: 'people_review', label: 'Đánh giá nhân sự', permissions: ['people_review.read', 'people_review.write', 'care.read'] },
    { key: 'opportunity', label: 'Cơ hội', permissions: ['opportunity.read', 'opportunity.write'] },
    { key: 'action', label: 'Hành động', permissions: ['action.draft', 'action.approve'] },
    { key: 'audit', label: 'Nhật ký', permissions: ['audit.read'] },
  ],
  roles: [
    { code: 'owner', name: 'Owner — Sếp', meta: 'thấy toàn cảnh', permissions: { 'overview.read': 'all', 'queue.read': 'all', 'queue.act': 'all', 'profile.read': 'all', 'profile.write': 'all', 'people_review.read': 'all', 'people_review.write': 'all', 'care.read': 'all', 'opportunity.read': 'all', 'opportunity.write': 'all', 'action.draft': 'all', 'action.approve': 'all', 'audit.read': 'all' } },
    { code: 'manager', name: 'Manager', meta: 'thấy team mình', permissions: { 'overview.read': 'team', 'queue.read': 'team', 'queue.act': 'team', 'profile.read': 'team', 'profile.write': 'team', 'people_review.read': 'none', 'people_review.write': 'none', 'care.read': 'none', 'opportunity.read': 'team', 'opportunity.write': 'team', 'action.draft': 'team', 'action.approve': 'team', 'audit.read': 'team' } },
    { code: 'operator', name: 'Operator', meta: 'thấy hàng đợi việc', permissions: { 'overview.read': 'none', 'queue.read': 'all', 'queue.act': 'all', 'profile.read': 'all', 'profile.write': 'all', 'people_review.read': 'none', 'people_review.write': 'none', 'care.read': 'none', 'opportunity.read': 'all', 'opportunity.write': 'all', 'action.draft': 'assigned', 'action.approve': 'none', 'audit.read': 'none' } },
    { code: 'agent_staff', name: 'Agent nhân viên', meta: 'chỉ khách được phân', permissions: { 'overview.read': 'none', 'queue.read': 'assigned', 'queue.act': 'assigned', 'profile.read': 'assigned', 'profile.write': 'assigned', 'people_review.read': 'none', 'people_review.write': 'none', 'care.read': 'none', 'opportunity.read': 'assigned', 'opportunity.write': 'assigned', 'action.draft': 'assigned', 'action.approve': 'none', 'audit.read': 'none' } },
    { code: 'auditor', name: 'Auditor', meta: 'xem, không hành động', permissions: { 'overview.read': 'all', 'queue.read': 'none', 'queue.act': 'none', 'profile.read': 'none', 'profile.write': 'none', 'people_review.read': 'none', 'people_review.write': 'none', 'care.read': 'none', 'opportunity.read': 'none', 'opportunity.write': 'none', 'action.draft': 'none', 'action.approve': 'none', 'audit.read': 'all' } },
  ],
};

const BOUNDARIES: Boundary[] = [
  { code: 'listen_authorized_only', label: 'Chỉ lắng nghe nhóm Owner đã bật', enabled: true, locked: true, params: {} },
  { code: 'auto_personnel_decisions', label: 'Hệ thống tự ra quyết định nhân sự', enabled: false, locked: true, params: {} },
  { code: 'approval_gate', label: 'Gửi ra ngoài / vượt ngưỡng tiền / liên quan nhân sự luôn chờ duyệt', enabled: true, locked: true, params: { approval_threshold_vnd: 50_000_000 } },
  { code: 'observe_external_market', label: 'Quan sát nhóm thị trường bên ngoài', enabled: true, locked: false, params: {} },
];

const RETENTION: RetentionPolicy[] = [
  { dataset: 'raw.events', keep_days: 365, anonymize_after_days: null },
  { dataset: 'clean.meaning_units', keep_days: 730, anonymize_after_days: null },
  { dataset: 'ops.action_log', keep_days: 2555, anonymize_after_days: null },
  { dataset: 'memory.entries', keep_days: null, anonymize_after_days: null },
  { dataset: 'agent.model_calls', keep_days: 90, anonymize_after_days: 30 },
];

describe('Điều khiển hệ thống › Quyền hạn', () => {
  it('ma trận quyền: khoá Owner (luôn toàn quyền) và Auditor (cột ghi) — ô khoá không có select để sửa', async () => {
    mockFetch((c) => {
      if (c.url.endsWith('/permissions') && c.method === 'GET') return json(200, PERMISSIONS_PAGE);
      if (c.url.endsWith('/listening-groups')) return json(200, []);
      if (c.url.endsWith('/boundaries')) return json(200, BOUNDARIES);
      return json(404);
    });
    renderScreen(<SystemScreen />, FULL_PERMS, 'roles');
    await screen.findByText('Ma trận quyền theo vai trò');

    const ownerRow = (await screen.findByText('Owner — Sếp')).closest('tr') as HTMLElement;
    // Owner: mọi cột đều là icon khoá (không có <select>) — khoá cứng ARCHITECTURE §8.3.
    expect(within(ownerRow).queryAllByRole('combobox')).toHaveLength(0);

    const managerRow = screen.getByText('Manager').closest('tr') as HTMLElement;
    // Manager không phải Owner/Auditor: mọi cột sửa được → có <select> cho từng cột.
    expect(within(managerRow).getAllByRole('combobox').length).toBe(PERMISSIONS_PAGE.columns.length);
  });

  it('sửa một ô (Manager · Hành động) gửi đúng PATCH /permissions rồi cập nhật lại bảng', async () => {
    let current = PERMISSIONS_PAGE;
    const calls = mockFetch((c) => {
      if (c.url.endsWith('/permissions') && c.method === 'GET') return json(200, current);
      if (c.url.endsWith('/permissions') && c.method === 'PATCH') {
        const b = c.body as { role: string; permission: string; scope: PermScope };
        current = { ...current, roles: current.roles.map((r) => (r.code === b.role ? { ...r, permissions: { ...r.permissions, [b.permission]: b.scope } } : r)) };
        return json(200, current);
      }
      if (c.url.endsWith('/listening-groups')) return json(200, []);
      if (c.url.endsWith('/boundaries')) return json(200, BOUNDARIES);
      return json(404);
    });
    const user = userEvent.setup();
    renderScreen(<SystemScreen />, FULL_PERMS, 'roles');
    await screen.findByText('Ma trận quyền theo vai trò');

    const managerRow = (await screen.findByText('Manager')).closest('tr') as HTMLElement;
    const actionSelect = within(managerRow).getByLabelText('Manager · Hành động') as HTMLSelectElement;
    expect(actionSelect.value).toBe('team');
    await user.selectOptions(actionSelect, 'none');

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/permissions') && c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ role: 'manager', permission: 'action.draft', scope: 'none' });
  });

  it('ranh giới có trách nhiệm: 6 dòng từ API + 2 dòng tĩnh (không công tắc), khoá cứng disable Switch', async () => {
    mockFetch((c) => {
      if (c.url.endsWith('/permissions')) return json(200, PERMISSIONS_PAGE);
      if (c.url.endsWith('/listening-groups')) return json(200, []);
      if (c.url.endsWith('/boundaries')) return json(200, BOUNDARIES);
      return json(404);
    });
    renderScreen(<SystemScreen />, FULL_PERMS, 'roles');
    await screen.findByText('Ranh giới có trách nhiệm');
    await screen.findByText('Chỉ lắng nghe nhóm Owner đã bật');
    // 2 khoá cứng không có dòng ops.policy_boundaries (STATIC_HARD_BOUNDARIES) — hiện tĩnh, "Không có công tắc".
    expect(screen.getAllByText('Không có công tắc')).toHaveLength(2);
    const lockedRow = screen.getByText('Chỉ lắng nghe nhóm Owner đã bật').closest('.boundary-row') as HTMLElement;
    expect(within(lockedRow).getByRole('switch')).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('Điều khiển hệ thống › Nhật ký', () => {
  it('tìm theo tên/hành động lọc bảng phía client; Xuất CSV gọi đúng GET /audit-log/export', async () => {
    const AUDIT_ITEMS = [
      { id: '1', at: '2026-09-20T08:00:00Z', actor_type: 'user', actor_id: 'u1', actor_label: 'Anh Cơ La', action: 'auth.pin_verified', target_type: null, target_id: null, target_label: null, autonomy_level: null, result: 'ok', detail: null },
      { id: '2', at: '2026-09-20T07:00:00Z', actor_type: 'agent', actor_id: 'a1', actor_label: 'Trợ lý thương mại', action: 'draft.created', target_type: 'draft', target_id: 'd1', target_label: 'ACT-0231', autonomy_level: 4, result: 'held', detail: null },
    ];
    const calls = mockFetch((c) => {
      if (c.url.includes('/audit-log/export')) return json(200, 'at,actor_type\n2026-09-20,user');
      if (c.url.includes('/audit-log')) return json(200, { items: AUDIT_ITEMS, next_cursor: null });
      return json(404);
    });
    // jsdom không có URL.createObjectURL — chỉ downloadText (chạy sau khi export xong) cần nó, xem e2e cho tải tệp thật.
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });
    const user = userEvent.setup();
    renderScreen(<SystemScreen />, FULL_PERMS, 'log');
    await screen.findByText('Trợ lý thương mại');
    expect(screen.getByText('Anh Cơ La')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Tìm trong nhật ký'), 'Trợ lý');
    expect(screen.queryByText('Anh Cơ La')).not.toBeInTheDocument();
    expect(screen.getByText('Trợ lý thương mại')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Xuất CSV/ }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/audit-log/export'))).toBe(true));
  });

  it('vai trò không có audit.read thấy thông báo khoá, không thấy bảng', async () => {
    mockFetch(() => json(404));
    renderScreen(<SystemScreen />, { 'system.read': 'all' }, 'log');
    expect(await screen.findByText('Vai trò của bạn không xem được Nhật ký')).toBeInTheDocument();
  });
});

describe('Điều khiển hệ thống › Dữ liệu & lưu trữ', () => {
  it('sửa hạn lưu một tập dữ liệu gửi đúng PATCH /retention-policies', async () => {
    let current = RETENTION;
    const calls = mockFetch((c) => {
      if (c.url.endsWith('/retention-policies') && c.method === 'GET') return json(200, current);
      if (c.url.endsWith('/retention-policies') && c.method === 'PATCH') {
        const b = c.body as { dataset: string; keep_days: number | null; anonymize_after_days: number | null };
        current = current.map((r) => (r.dataset === b.dataset ? { ...r, keep_days: b.keep_days, anonymize_after_days: b.anonymize_after_days } : r));
        return json(200, current);
      }
      if (c.url.includes('/directory/people')) return json(200, { items: [], next_cursor: null, total: 0 });
      return json(404);
    });
    const user = userEvent.setup();
    renderScreen(<SystemScreen />, FULL_PERMS, 'storage');
    await screen.findByText('Hạn lưu dữ liệu');

    const rawRow = (await screen.findByText(/Kho thô/)).closest('tr') as HTMLElement;
    await user.click(within(rawRow).getByRole('button', { name: 'Sửa' }));
    const keepInput = within(rawRow).getByLabelText(/Giữ trong \(ngày\)/) as HTMLInputElement;
    await user.clear(keepInput);
    await user.type(keepInput, '180');
    await user.click(within(rawRow).getByRole('button', { name: 'Lưu' }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/retention-policies') && c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ dataset: 'raw.events', keep_days: 180, anonymize_after_days: null });
  });

  it('yêu cầu xuất dữ liệu một người gọi đúng POST /persons/{id}/data-requests với kind=export', async () => {
    const calls = mockFetch((c) => {
      if (c.url.endsWith('/retention-policies')) return json(200, RETENTION);
      if (c.url.includes('/directory/people')) return json(200, { items: [{ id: 'p1', code: 'PER-0042', name: 'Nguyễn Văn Bảo', type: null, org_name: null, relation: 'customer', channels: [], heat: null, heat_trend: null, value_vnd: null, priority: 'normal', bot: null }], next_cursor: null, total: 1 });
      if (c.url.includes('/persons/p1/data-requests') && c.method === 'POST') return json(201, { id: 'req1', kind: 'export', status: 'completed', result: {} });
      if (c.url.includes('/persons/p1/data-requests') && c.method === 'GET') return json(200, []);
      return json(404);
    });
    const user = userEvent.setup();
    renderScreen(<SystemScreen />, FULL_PERMS, 'storage');
    await screen.findByText('Yêu cầu xuất / xoá dữ liệu một người');
    await screen.findByText('Nguyễn Văn Bảo · PER-0042');

    await user.selectOptions(screen.getByLabelText('Người'), 'p1');
    await user.click(screen.getByRole('button', { name: 'Xuất dữ liệu' }));

    await waitFor(() => expect(calls.some((c) => c.url.includes('/persons/p1/data-requests') && c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.url.includes('/persons/p1/data-requests') && c.method === 'POST');
    expect(post?.body).toEqual({ kind: 'export' });
  });
});
