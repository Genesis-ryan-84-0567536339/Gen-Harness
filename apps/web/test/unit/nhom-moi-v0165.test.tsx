import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Channel, ChannelGroup } from '@gen-harness/contracts';
import { ChannelCard } from '../../src/screens/system/ChannelCard';
import { NEW_GROUP_MODES, newGroupModeOf } from '../../src/screens/system/systemModel';
import { PinDialogHost } from '../../src/shell/PinDialogHost';
import { ToastHost } from '../../src/shell/ToastHost';
import { queryClient } from '../../src/lib/queryClient';
import { qk2, useChannels } from '../../src/lib/dataQueries';

// v0.1.65 (F1d): «Nhóm mới» có mặc định cho các nhóm SAU — ô «Áp dụng cho các nhóm mới sau này» ở hộp hỏi và ô chỉnh
// «Nhóm mới: Hỏi Sếp / Im lặng / Không nghe» ở thẻ kênh (đổi cần PIN). Máy chủ giả bằng fetch.

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

const grp = (id: string, name: string, mode: ChannelGroup['listen_mode']): ChannelGroup => ({
  id, code: `GRP-ZL-${id}`, name, members: 5, kind: 'internal', listen_mode: mode, view_scope: 'owner',
});

const zalo = (over: Partial<Channel> = {}): Channel => ({
  type: 'zalo', name: 'Zalo', installed: true, id: 'c1', state: 'active', account_label: 'iPhone của Sếp',
  started_at: new Date(Date.now() - 3600_000).toISOString(), groups_listening: 1, outbound_queued: 0,
  last_heartbeat_at: new Date().toISOString(), stats: null, qr: null, listen_direct: true, direct_mode: 'silent', groups_pending: 2,
  new_group_mode: 'ask', new_group_asked: false, ...over,
});

const PENDING = [grp('1', 'Khách sỉ Hà Nội', 'pending'), grp('2', 'Đối tác kho', 'pending')];
const fallback = (c: Call, over: Partial<Channel> = {}) => json(200, c.url.endsWith('/channels') ? [zalo(over)] : []);

function Card({ canManage = true }: { canManage?: boolean }) {
  const channels = useChannels();
  const c = channels.data?.[0];
  return c ? <ChannelCard channel={c} canManage={canManage} /> : null;
}

function renderCard(c: Channel, canManage = true) {
  queryClient.setQueryData(qk2.channels, [c]);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Card canManage={canManage} />
        <PinDialogHost />
        <ToastHost />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  vi.unstubAllGlobals();
});

describe('hằng «Nhóm mới»', () => {
  it('ba mức, mặc định Hỏi Sếp; máy chủ cũ (không có khoá) = không hiện; giá trị lạ = Hỏi Sếp', () => {
    expect(NEW_GROUP_MODES.map((m) => [m.value, m.label])).toEqual([['ask', 'Hỏi Sếp'], ['silent', 'Im lặng'], ['off', 'Không nghe']]);
    expect(newGroupModeOf({})).toBeUndefined();
    expect(newGroupModeOf({ new_group_mode: 'silent' })).toBe('silent');
    expect(newGroupModeOf({ new_group_mode: 'bậy' as never })).toBe('ask');
  });
});

describe('hộp hỏi: ô «Áp dụng cho các nhóm mới sau này»', () => {
  it('lần hỏi đầu sau khi nối kênh: ô có sẵn và ĐÃ BẬT; giải thích cần PIN', async () => {
    mockFetch((c) => (c.url.includes('pending=1') ? json(200, PENDING) : fallback(c)));
    renderCard(zalo({ new_group_asked: false }));
    const apply = await screen.findByTestId('newgroups-apply-zalo');
    expect(within(apply).getByRole('checkbox')).toBeChecked();
    expect(apply).toHaveTextContent(/Áp dụng cho các nhóm mới sau này/);
    expect(apply).toHaveTextContent(/Cần mã PIN/);
  });

  it('đã hỏi rồi (new_group_asked): ô có nhưng KHÔNG bật sẵn', async () => {
    mockFetch((c) => (c.url.includes('pending=1') ? json(200, PENDING) : fallback(c, { new_group_asked: true })));
    renderCard(zalo({ new_group_asked: true }));
    const apply = await screen.findByTestId('newgroups-apply-zalo');
    expect(within(apply).getByRole('checkbox')).not.toBeChecked();
  });

  it('máy chủ cũ (không có new_group_mode) hoặc vai chỉ đọc: không có ô', async () => {
    mockFetch((c) => (c.url.includes('pending=1') ? json(200, PENDING) : fallback(c)));
    const old = zalo();
    delete old.new_group_mode;
    delete old.new_group_asked;
    const { unmount } = renderCard(old);
    await screen.findByTestId('newgroups-zalo');
    expect(screen.queryByTestId('newgroups-apply-zalo')).not.toBeInTheDocument();
    unmount();
    queryClient.clear();
    renderCard(zalo(), false);
    await screen.findByTestId('newgroups-zalo');
    expect(screen.queryByTestId('newgroups-apply-zalo')).not.toBeInTheDocument();
  });

  it('bật sẵn: bấm Im lặng gửi apply_to_new và báo nhóm sau cũng vào Im lặng', async () => {
    const user = userEvent.setup();
    const calls = mockFetch((c) =>
      c.method === 'PATCH' ? json(200, grp('1', 'Khách sỉ Hà Nội', 'silent')) : c.url.includes('pending=1') ? json(200, PENDING) : fallback(c),
    );
    renderCard(zalo());
    await user.click(await screen.findByRole('button', { name: 'Im lặng — nhóm Khách sỉ Hà Nội' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const p = calls.find((c) => c.method === 'PATCH')!;
    expect(p.url).toMatch(/\/channels\/zalo\/groups\/1\/mode$/);
    expect(p.body).toEqual({ mode: 'silent', apply_to_new: true });
    expect(await screen.findByText(/Nhóm mới sau này cũng vào Im lặng/)).toBeInTheDocument();
  });

  it('bỏ tick: chỉ chọn cho nhóm này (không gửi apply_to_new)', async () => {
    const user = userEvent.setup();
    const calls = mockFetch((c) =>
      c.method === 'PATCH' ? json(200, grp('2', 'Đối tác kho', 'off')) : c.url.includes('pending=1') ? json(200, PENDING) : fallback(c),
    );
    renderCard(zalo());
    await user.click(within(await screen.findByTestId('newgroups-apply-zalo')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Không nghe — nhóm Đối tác kho' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ mode: 'off' });
    expect(await screen.findByText('Đã chọn: Không nghe — không lưu tin')).toBeInTheDocument();   // không kèm «sau này»
  });

  it('«Tất cả 2 nhóm: Không nghe» + ô bật: mọi lượt gửi mode off kèm apply_to_new', async () => {
    const user = userEvent.setup();
    const calls = mockFetch((c) =>
      c.method === 'PATCH' ? json(200, grp('1', 'x', 'off')) : c.url.includes('pending=1') ? json(200, PENDING) : fallback(c),
    );
    renderCard(zalo());
    await user.click(await screen.findByRole('button', { name: /Tất cả 2 nhóm: Không nghe/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
      { mode: 'off', apply_to_new: true },
      { mode: 'off', apply_to_new: true },
    ]);
  });
});

describe('thẻ kênh: ô «Nhóm mới»', () => {
  function renderWith(c: Channel, canManage = true) {
    const calls = mockFetch((call) => {
      if (call.method === 'PATCH' && call.url.endsWith('/channels/zalo')) {
        return json(200, { ...c, new_group_mode: (call.body as { new_group_mode: Channel['new_group_mode'] }).new_group_mode, new_group_asked: true });
      }
      return fallback(call, { groups_pending: 0, ...c });
    });
    renderCard({ ...c, groups_pending: 0 }, canManage);
    return calls;
  }

  it('hiện mặc định "Hỏi Sếp" với giải thích và 3 lựa chọn; ghi chú cần mã PIN', async () => {
    renderWith(zalo());
    const sel = (await screen.findByLabelText('Nhóm mới trên Zalo')) as HTMLSelectElement;
    expect(sel.value).toBe('ask');
    expect(within(sel).getAllByRole('option').map((o) => o.textContent)).toEqual(['Hỏi Sếp', 'Im lặng', 'Không nghe']);
    expect(screen.getByTestId('newmode-hint-zalo')).toHaveTextContent(/chờ Sếp chọn.*Đổi cần mã PIN/s);
    expect(screen.getByTestId('newmode-hint-zalo')).toHaveTextContent(/Chỉ áp cho nhóm phát hiện sau này/);
  });

  it('đổi sang Im lặng gọi PATCH /channels/zalo {new_group_mode: silent} và báo kết quả', async () => {
    const user = userEvent.setup();
    const calls = renderWith(zalo());
    await user.selectOptions(await screen.findByLabelText('Nhóm mới trên Zalo'), 'silent');
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const p = calls.find((c) => c.method === 'PATCH')!;
    expect(p.url).toMatch(/\/channels\/zalo$/);
    expect(p.body).toEqual({ new_group_mode: 'silent' });
    expect(await screen.findByText(/nhóm mới tự vào Im lặng — lưu tin, không tự trả lời/)).toBeInTheDocument();
    expect((screen.getByLabelText('Nhóm mới trên Zalo') as HTMLSelectElement).value).toBe('silent');
  });

  it('thiếu PIN (423): hộp nhập PIN hiện lên, chưa đổi gì', async () => {
    const user = userEvent.setup();
    const calls = mockFetch((call) =>
      call.method === 'PATCH'
        ? json(423, { type: 'about:blank', title: 'Thao tác này cần nhập mã PIN', status: 423, code: 'PIN_REQUIRED' })
        : fallback(call, { groups_pending: 0 }),
    );
    renderCard(zalo({ groups_pending: 0 }));
    await user.selectOptions(await screen.findByLabelText('Nhóm mới trên Zalo'), 'off');
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('vai chỉ đọc: thấy giá trị nhưng không đổi được; máy chủ cũ: không có ô', async () => {
    mockFetch((c) => fallback(c, { groups_pending: 0, new_group_mode: 'off' }));
    const { unmount } = renderCard(zalo({ groups_pending: 0, new_group_mode: 'off' }), false);
    const sel = (await screen.findByLabelText('Nhóm mới trên Zalo')) as HTMLSelectElement;
    expect(sel.value).toBe('off');
    expect(sel).toBeDisabled();
    unmount();
    queryClient.clear();
    const old = zalo({ groups_pending: 0 });
    delete old.new_group_mode;
    mockFetch((c) => json(200, c.url.endsWith('/channels') ? [old] : []));
    renderCard(old);
    await screen.findByText('Zalo');
    expect(screen.queryByLabelText('Nhóm mới trên Zalo')).not.toBeInTheDocument();
  });
});
