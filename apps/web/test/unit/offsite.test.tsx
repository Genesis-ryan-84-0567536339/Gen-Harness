import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { NotificationItem, NotificationsPage, OffsiteState } from '@gen-harness/contracts';
import { OffsitePanel } from '../../src/screens/system/OffsitePanel';
import { NotificationBell } from '../../src/shell/NotificationBell';
import { PinDialogHost } from '../../src/shell/PinDialogHost';
import { queryClient } from '../../src/lib/queryClient';
import { qk } from '../../src/lib/queries';
import { qkSystem } from '../../src/screens/system/queries';
import { ageDays, offsiteErrorText, offsiteRequestView, offsiteScheduleText, offsiteView } from '../../src/screens/system/offsiteModel';

/**
 * v0.1.40 (F-12): thẻ "Bản sao ngoài máy" (Dữ liệu & lưu trữ) + Bộ khôi phục + chuông kind mới. Khuôn API theo hợp đồng
 * `GET /system/offsite` — mọi trường là chuỗi/số/bool/null.
 */

const DAY = 24 * 3600 * 1000;
const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' } });

function meAs(role: 'owner' | 'manager', pinUntil: string | null = null) {
  return {
    id: 'u', email: `${role}@genesis.local`, display_name: role, role: { code: role, name: role },
    org: { id: 'o', name: 'x', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' }, addressing: { self: 'Anh', bot_calls_me: 'Sếp' },
    pin_verified_until: pinUntil, permissions: { 'system.read': 'all', 'system.manage': 'all' },
  };
}

function state(over: Partial<OffsiteState> = {}): OffsiteState {
  return {
    configured: true, dest: '/media/sep/GEN-USB', state: 'ok', error_code: null, message: null,
    last_attempt_at: new Date(Date.now() - 2 * DAY).toISOString(), last_success_at: new Date(Date.now() - 2 * DAY).toISOString(),
    age_days: 2, stale: false, last_size_bytes: 1_288_490_189, verified: true, key_id: 'a1b2c3d4', schedule: 'systemd',
    request: { state: 'idle', action: null, requested_at: null }, can_request: true, manual_command: null, key_present: true,
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}
function mockFetch(handler: (c: Call) => Response | undefined, role: 'owner' | 'manager' = 'owner') {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const c = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(c);
      const r = handler(c);
      if (r) return r;
      if (c.url.endsWith('/auth/me')) return json(200, meAs(role));
      return json(404, { status: 404, code: 'NOT_FOUND', title: 'Không tìm thấy' });
    }),
  );
  return calls;
}

function renderPanel(role: 'owner' | 'manager' = 'owner') {
  queryClient.setQueryData(qk.me, meAs(role));
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <OffsitePanel />
        <PinDialogHost />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function enterPin(user: ReturnType<typeof userEvent.setup>) {
  const pin = await screen.findByRole('dialog', { name: 'Mã PIN xác nhận thao tác' });
  const boxes = within(pin).getAllByLabelText(/Mã PIN — chữ số/);
  await waitFor(() => expect(boxes[0]).toHaveFocus());
  await user.keyboard('246810');
}

const PIN_REQUIRED = () => json(423, { status: 423, code: 'PIN_REQUIRED', title: 'Thao tác này cần nhập mã PIN' });
const PIN_OK = () => json(200, { pin_verified_until: new Date(Date.now() + 1800_000).toISOString() });

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  document.cookie = 'gh_csrf=test-csrf';
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.getElementById('gh-portable-frame')?.remove();
});

describe('offsiteModel', () => {
  const NOW = Date.parse('2026-10-02T03:00:00Z');
  const ago = (d: number) => new Date(NOW - d * DAY).toISOString();

  it('tuổi theo ngày (làm tròn xuống), null khi không có / không đọc được', () => {
    expect(ageDays(ago(8.9), NOW)).toBe(8);
    expect(ageDays(ago(0.2), NOW)).toBe(0);
    expect(ageDays(null, NOW)).toBeNull();
    expect(ageDays('không phải ngày', NOW)).toBeNull();
  });

  it('stale/tông: chưa có ⇒ vàng; 2 ngày ⇒ không cảnh báo; 8 ngày ⇒ vàng; 31 ngày ⇒ đỏ', () => {
    const none = offsiteView(state({ last_success_at: null, age_days: null, stale: true, configured: false, dest: null }), NOW);
    expect(none).toMatchObject({ headline: 'Chưa có bản sao ngoài máy', stale: true, tone: 'warn', hasCopy: false });
    expect(none.warning).toMatch(/^Hỏng ổ đĩa là mất hết dữ liệu — /);
    expect(offsiteView(state({ last_success_at: ago(2) }), NOW)).toMatchObject({ stale: false, tone: 'none', warning: null, days: 2 });
    expect(offsiteView(state({ last_success_at: ago(8) }), NOW)).toMatchObject({ stale: true, tone: 'warn', days: 8 });
    expect(offsiteView(state({ last_success_at: ago(31) }), NOW)).toMatchObject({ stale: true, tone: 'bad', days: 31 });
    const ok = offsiteView(state({ last_success_at: ago(2) }), NOW, 'Asia/Ho_Chi_Minh');
    expect(ok.headline).toMatch(/^Bản sao ngoài máy gần nhất: .+ \(2 ngày trước\) · 1,2 GB · đã kiểm đọc lại được$/);
  });

  it('nhãn lỗi: ưu tiên message của API, không có thì theo mã GH-EBxx; mã lạ ⇒ câu chung', () => {
    expect(offsiteErrorText('GH-EB01', null)).toContain('Chưa thấy ổ USB/NAS');
    expect(offsiteErrorText('GH-EB01', 'Câu của API')).toBe('Câu của API');
    expect(offsiteErrorText('GH-EB99', null)).toBe('Lần sao lưu ra ổ ngoài gần nhất chưa thành công.');
    const v = offsiteView(state({ state: 'not_mounted', error_code: 'GH-EB01' }), NOW);
    expect(v.error).toEqual({ text: expect.stringContaining('Chưa thấy ổ USB/NAS'), code: 'GH-EB01' });
  });

  it('lịch và yêu cầu: "Mỗi Chủ nhật ~05:30" / "Chưa bật lịch"; chờ nhận ⇒ waiting, quá 15 phút ⇒ stalled', () => {
    expect(offsiteScheduleText('systemd')).toBe('Mỗi Chủ nhật ~05:30');
    expect(offsiteScheduleText('')).toBe('Chưa bật lịch');
    expect(offsiteScheduleText(null)).toBe('Chưa bật lịch');
    const req = (minutes: number) => state({ request: { state: 'requested', action: 'set', requested_at: new Date(NOW - minutes * 60_000).toISOString() } });
    expect(offsiteRequestView(req(1), NOW)).toEqual({ kind: 'waiting', text: 'Đang chờ máy chủ nhận yêu cầu đổi nơi lưu…' });
    expect(offsiteRequestView(req(20), NOW).kind).toBe('stalled');
    expect(offsiteRequestView(state({ state: 'running' }), NOW).kind).toBe('running');
    expect(offsiteRequestView(state(), NOW).kind).toBe('none');
  });
});

describe('Bản sao ngoài máy — thẻ', () => {
  it('chưa có bản sao ⇒ "Chưa có bản sao ngoài máy" + cảnh báo vàng', async () => {
    mockFetch((c) => (c.url.endsWith('/system/offsite') ? json(200, state({ configured: false, dest: null, last_success_at: null, last_attempt_at: null, age_days: null, stale: true, verified: false, schedule: null, state: 'not_configured', error_code: 'GH-EB00' })) : undefined));
    renderPanel();
    expect(await screen.findByText('Chưa có bản sao ngoài máy')).toBeInTheDocument();
    const warn = screen.getByTestId('offsite-warning');
    expect(warn).toHaveAttribute('data-tone', 'warn');
    expect(warn).toHaveTextContent('Hỏng ổ đĩa là mất hết dữ liệu');
    expect(screen.getByText('Chưa chọn')).toBeInTheDocument();
    expect(screen.getByText('Chưa bật lịch')).toBeInTheDocument();
    // Chưa chọn nơi lưu không phải "lỗi" — không có khối lỗi riêng.
    expect(screen.queryByTestId('offsite-error')).toBeNull();
  });

  it.each([
    [8, 'warn'],
    [31, 'bad'],
  ])('lần thành công gần nhất %i ngày trước ⇒ cảnh báo tông %s', async (days, tone) => {
    mockFetch((c) => (c.url.endsWith('/system/offsite') ? json(200, state({ last_success_at: new Date(Date.now() - days * DAY - 3600_000).toISOString(), age_days: days, stale: true })) : undefined));
    renderPanel();
    const warn = await screen.findByTestId('offsite-warning');
    expect(warn).toHaveAttribute('data-tone', tone);
    expect(screen.getByTestId('offsite-latest')).toHaveTextContent(`(${days} ngày trước)`);
  });

  it('2 ngày ⇒ không cảnh báo; hiện nơi lưu, lịch tuần, mã khoá', async () => {
    mockFetch((c) => (c.url.endsWith('/system/offsite') ? json(200, state({ last_success_at: new Date(Date.now() - 2 * DAY - 3600_000).toISOString() })) : undefined));
    renderPanel();
    const latest = await screen.findByTestId('offsite-latest');
    expect(latest).toHaveTextContent(/Bản sao ngoài máy gần nhất: .* \(2 ngày trước\) · 1,2 GB · đã kiểm đọc lại được/);
    expect(screen.queryByTestId('offsite-warning')).toBeNull();
    expect(screen.getByText('/media/sep/GEN-USB')).toBeInTheDocument();
    expect(screen.getByText('Mỗi Chủ nhật ~05:30')).toBeInTheDocument();
    expect(screen.getByText('a1b2c3d4')).toBeInTheDocument();
  });

  it('state not_mounted ⇒ câu thân thiện + "Chi tiết kỹ thuật" chứa GH-EB01 (chuỗi, không object)', async () => {
    mockFetch((c) =>
      c.url.endsWith('/system/offsite')
        ? json(200, state({ state: 'not_mounted', error_code: 'GH-EB01', message: 'Chưa thấy ổ USB/NAS — cắm ổ vào máy chủ rồi thử lại.' }))
        : undefined,
    );
    renderPanel();
    const err = await screen.findByTestId('offsite-error');
    expect(err).toHaveTextContent('Chưa thấy ổ USB/NAS — cắm ổ vào máy chủ rồi thử lại.');
    const details = err.querySelector('details') as HTMLElement;
    expect(within(details).getByText('Chi tiết kỹ thuật')).toBeInTheDocument();
    expect(within(details).getByText('GH-EB01')).toBeInTheDocument();
    expect(screen.queryByText('[object Object]')).toBeNull();
  });

  it('Chọn nơi lưu: PUT đúng body; 423 ⇒ hộp PIN rồi gửi lại; xong ⇒ "Đang chờ máy chủ nhận…"', async () => {
    let pinOk = false;
    let current = state();
    const calls = mockFetch((c) => {
      if (c.url.endsWith('/system/offsite') && c.method === 'GET') return json(200, current);
      if (c.url.endsWith('/system/offsite/destination') && c.method === 'PUT') {
        if (!pinOk) return PIN_REQUIRED();
        current = state({ request: { state: 'requested', action: 'set', requested_at: new Date().toISOString() } });
        return json(202, current);
      }
      if (c.url.endsWith('/auth/pin/verify')) {
        pinOk = true;
        return PIN_OK();
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Chọn nơi lưu bản sao ngoài máy' }));
    const dlg = await screen.findByRole('dialog', { name: 'Chọn nơi lưu bản sao ngoài máy' });
    expect(dlg).toHaveTextContent('Ổ phải đang cắm/đã mount; hệ thống không ghi vào ổ chính');
    expect(dlg).toHaveTextContent('/Volumes/<ổ>');
    expect(dlg).toHaveTextContent('E:\\GenBackup');
    const input = within(dlg).getByLabelText('Đường dẫn ổ USB/NAS trên máy chủ');
    await user.clear(input);
    await user.type(input, '/media/sep/USB2');
    await user.click(within(dlg).getByRole('button', { name: 'Lưu' }));
    await enterPin(user);

    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/system/offsite/destination'))).toHaveLength(2));
    for (const c of calls.filter((x) => x.url.endsWith('/destination'))) expect(c.body).toEqual({ path: '/media/sep/USB2' });
    expect(await screen.findByTestId('offsite-request')).toHaveTextContent('Đang chờ máy chủ nhận yêu cầu đổi nơi lưu…');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Chọn nơi lưu bản sao ngoài máy' })).toBeNull());
  });

  it('409 OFFSITE_UNAVAILABLE ⇒ hiện manual_command trong khối mã có nút Chép', async () => {
    mockFetch((c) => {
      if (c.url.endsWith('/system/offsite') && c.method === 'GET') return json(200, state());
      if (c.url.endsWith('/system/offsite/destination')) {
        return json(409, { status: 409, code: 'OFFSITE_UNAVAILABLE', title: 'Máy chủ chưa bật nhận yêu cầu', manual_command: 'genh offsite set E:\\GenBackup' });
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Chọn nơi lưu bản sao ngoài máy' }));
    const dlg = await screen.findByRole('dialog', { name: 'Chọn nơi lưu bản sao ngoài máy' });
    const input = within(dlg).getByLabelText('Đường dẫn ổ USB/NAS trên máy chủ');
    await user.clear(input);
    await user.type(input, 'E:\\GenBackup');
    await user.click(within(dlg).getByRole('button', { name: 'Lưu' }));
    const cmd = await within(dlg).findByTestId('offsite-manual-command');
    expect(within(cmd).getByText('genh offsite set E:\\GenBackup')).toBeInTheDocument();
    expect(within(cmd).getByRole('button', { name: 'Chép lệnh' })).toBeInTheDocument();
  });

  it('Manager chỉ thấy trạng thái + "Sao lưu ra ổ ngoài ngay", không thấy nút Owner', async () => {
    const calls = mockFetch((c) => {
      if (c.url.endsWith('/system/offsite') && c.method === 'GET') return json(200, state());
      if (c.url.endsWith('/system/offsite/run') && c.method === 'POST') return json(202, state({ request: { state: 'requested', action: 'run', requested_at: new Date().toISOString() } }));
      return undefined;
    }, 'manager');
    const user = userEvent.setup();
    renderPanel('manager');
    await screen.findByTestId('offsite-latest');
    expect(screen.queryByRole('button', { name: 'Chọn nơi lưu bản sao ngoài máy' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tải gói mang đi' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bộ khôi phục' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sao lưu ra ổ ngoài ngay' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/system/offsite/run') && c.method === 'POST')).toBe(true));
    expect(await screen.findByTestId('offsite-request')).toHaveTextContent('Đang chờ máy chủ nhận yêu cầu sao lưu ra ổ ngoài…');
  });

  it('Bộ khôi phục: PIN ⇒ khoá chữ to + mã QR SVG; đóng hộp ⇒ khoá biến khỏi DOM', async () => {
    const KEY = 'ABCDE-FGHIJ-KLMN2-OPQR3-STUV4-WXYZ5';
    let pinOk = false;
    const calls = mockFetch((c) => {
      if (c.url.endsWith('/system/offsite')) return json(200, state());
      if (c.url.endsWith('/system/offsite/recovery-kit')) {
        if (!pinOk) return PIN_REQUIRED();
        return json(200, { key: KEY, key_id: 'a1b2c3d4', steps: ['Cài Gen-Harness trên máy mới.', 'Nhập Khoá khôi phục khi được hỏi.'], warning: 'Ai có khoá này và ổ USB là mở được dữ liệu.' });
      }
      if (c.url.endsWith('/auth/pin/verify')) {
        pinOk = true;
        return PIN_OK();
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Bộ khôi phục' }));
    await enterPin(user);
    const dlg = await screen.findByRole('dialog', { name: 'Bộ khôi phục' });
    expect(await within(dlg).findByTestId('recovery-key')).toHaveTextContent(KEY);
    expect(dlg).toHaveTextContent('Cất TÁCH khỏi ổ USB');
    expect(dlg).toHaveTextContent('Nhập Khoá khôi phục khi được hỏi.');
    const svg = dlg.querySelector('svg.rk-qr') as SVGElement;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('aria-label')).toBe('Mã QR của Khoá khôi phục');
    expect(svg.querySelector('path')?.getAttribute('d')?.length ?? 0).toBeGreaterThan(100);
    expect(calls.filter((c) => c.url.endsWith('/recovery-kit'))).toHaveLength(2);
    // Khoá không nằm lại trong bộ đệm truy vấn/mutation.
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(KEY);
    expect(JSON.stringify(queryClient.getMutationCache().getAll().map((m) => m.state.data))).not.toContain(KEY);

    await user.click(within(dlg).getByRole('button', { name: 'Đã cất xong' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Bộ khôi phục' })).toBeNull());
    expect(document.body.textContent).not.toContain(KEY);
    expect(document.body.classList.contains('rk-open')).toBe(false);
  });

  it('Tải gói mang đi: xác nhận + PIN rồi điều hướng khung ẩn tới URL portable (không fetch blob)', async () => {
    const calls = mockFetch((c) => {
      if (c.url.endsWith('/system/offsite')) return json(200, state());
      if (c.url.endsWith('/auth/pin/verify')) return PIN_OK();
      return undefined;
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Tải gói mang đi' }));
    const dlg = await screen.findByRole('dialog', { name: 'Tải gói mang đi?' });
    expect(dlg).toHaveTextContent('mở bằng Bộ khôi phục');
    await user.click(within(dlg).getByRole('button', { name: 'Tải về' }));
    await enterPin(user);
    await waitFor(() => expect(document.getElementById('gh-portable-frame')).not.toBeNull());
    const frame = document.getElementById('gh-portable-frame') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('/api/v1/system/offsite/portable');
    expect(calls.some((c) => c.url.includes('/system/offsite/portable'))).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/auth/pin/verify'))).toBe(true);
  });
});

describe('Chuông — kind mới v0.1.40', () => {
  it.each(['offsite.stale', 'job.timeout'])('notification %s ⇒ làm mới [system, health]', async (kind) => {
    const first: NotificationItem = { id: 'a', kind: 'backup.done', title: 'Sao lưu đã xong', body: '', link: null, created_at: new Date().toISOString(), read: true };
    const page: NotificationsPage = { items: [first], unread: 0 };
    mockFetch((c) => (c.url.includes('/notifications') ? json(200, page) : undefined));
    queryClient.setQueryData(qk.me, meAs('owner'));
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <NotificationBell />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: 'Thông báo' });
    await waitFor(() => expect(queryClient.getQueryData(qk.notifications)).toBeDefined());
    // Lần tải đầu chỉ ghi nhận, không làm mới.
    await new Promise((r) => setTimeout(r, 20));
    expect(spy.mock.calls.some(([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(qkSystem.health))).toBe(false);
    const fresh: NotificationItem = { id: 'b', kind, title: 'Sự cố', body: '', link: '/system?tab=storage&focus=offsite', created_at: new Date().toISOString(), read: false };
    act(() => {
      queryClient.setQueryData<NotificationsPage>(qk.notifications, { items: [fresh, first], unread: 1 });
    });
    await waitFor(() => expect(spy.mock.calls.some(([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(qkSystem.health))).toBe(true));
    spy.mockRestore();
  });
});
