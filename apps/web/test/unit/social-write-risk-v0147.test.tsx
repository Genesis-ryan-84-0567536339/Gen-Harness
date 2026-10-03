/**
 * v0.1.47 (F-79/F-85) — trang cảnh báo rủi ro gửi Facebook (`/social/ghi-facebook`, chỉ Owner): ô sandbox, danh sách rủi ro từ API,
 * "Tôi hiểu rủi ro và đồng ý" (POST kèm version), "Rút lại đồng ý", sandbox bật thì không cần đồng ý, lỗi API thân thiện.
 * Cộng thẻ "Gửi trả lời & tin nhắn" ở trang Tài khoản mạng xã hội (cổng Mở/Khoá, giới hạn gửi/ngày, lần gửi gần đây).
 */
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { SocialAccount, SocialPlatforms, SocialWriteGate, SocialWriteItem } from '@gen-harness/contracts';
import { SocialPage } from '../../src/social/SocialPage';
import { SocialWriteRiskPage } from '../../src/social/SocialWriteRiskPage';
import { qk } from '../../src/lib/queries';
import { fmtConsentTime, writeStatusView } from '../../src/social/socialModel';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const me = (role: string) => ({
  id: 'u', email: 'x@genesis.local', display_name: 'Anh Cơ', role: { code: role, name: role },
  org: { id: 'o', name: 'x', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
  addressing: { self: 'Anh', bot_calls_me: 'Sếp' }, pin_verified_until: null,
  permissions: { 'system.read': 'all', 'system.manage': 'all' },
});

function renderPage(ui: ReactElement, role = 'owner') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.me, me(role));
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const RISKS = ['Trình duyệt nền chưa chạy được trong sandbox.', 'Facebook có thể hạn chế hoặc khoá tài khoản khi gửi tự động.'];
const PLATFORMS: SocialPlatforms = {
  items: [{
    key: 'facebook_personal', name: 'Facebook cá nhân', mode: 'browser', read_kinds: ['notifications'], write_kinds: ['reply_comment', 'send_message'],
    risk: ['x'], will_do: ['Gửi CHỈ sau khi Sếp bấm Xác nhận và nhập PIN.'], wont_do: ['Không đăng bài.'], risk_version: '2026-09-30',
  }],
  hard_rules: ['Không tạo tài khoản giả.'],
  risk_version: '2026-09-30',
};
const gate = (over: Partial<SocialWriteGate> = {}): SocialWriteGate => ({
  sandbox: { enabled: false, reason: 'Máy chủ không cho bật vùng cách ly của trình duyệt.', checked_at: '2026-10-03T01:00:00Z' },
  worker_online: true, consent: null, open: false, risk: RISKS, version: '2026-10-03', ...over,
});
const CONSENT = { accepted_at: '2026-10-03T01:30:00Z', accepted_by_name: 'Anh Cơ', version: '2026-10-03' };

function stub(state: { gate: SocialWriteGate; acceptError?: Response }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const c = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(c);
      if (c.url.endsWith('/social/write-gate')) return json(200, state.gate);
      if (c.url.endsWith('/social/platforms')) return json(200, PLATFORMS);
      if (c.url.endsWith('/social/write-consent') && c.method === 'POST') {
        if (state.acceptError) return state.acceptError;
        state.gate = gate({ consent: CONSENT, open: true });
        return json(200, state.gate);
      }
      if (c.url.endsWith('/social/write-consent') && c.method === 'DELETE') {
        state.gate = gate();
        return json(200, state.gate);
      }
      return json(404, { status: 404, code: 'NOT_FOUND', title: 'Không tồn tại' });
    }),
  );
  return calls;
}

describe('SocialWriteRiskPage', () => {
  it('chưa sandbox + chưa đồng ý: ô sandbox (lý do), danh sách rủi ro, sẽ/không làm và nút đồng ý — bấm → POST đúng version', async () => {
    const calls = stub({ gate: gate() });
    renderPage(<SocialWriteRiskPage />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Gửi trả lời & tin nhắn Facebook — cảnh báo rủi ro' })).toBeInTheDocument();
    const box = await screen.findByTestId('write-sandbox');
    expect(box).toHaveTextContent('Chưa bật');
    expect(box).toHaveTextContent('Máy chủ không cho bật vùng cách ly của trình duyệt.');
    const list = screen.getByRole('list', { name: 'Rủi ro khi gửi lên Facebook' });
    for (const r of RISKS) expect(within(list).getByText(r)).toBeInTheDocument();
    expect(await screen.findByText('Gửi CHỈ sau khi Sếp bấm Xác nhận và nhập PIN.')).toBeInTheDocument();
    expect(screen.getByText('Không đăng bài.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rút lại đồng ý' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Tôi hiểu rủi ro và đồng ý' }));
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toMatch(/\/social\/write-consent$/);
    expect(post?.body).toEqual({ version: '2026-10-03' });
    // Sau khi đồng ý: hiện thời điểm + phiên bản và nút rút lại; nút đồng ý biến mất.
    const info = await screen.findByTestId('write-consent-info');
    expect(info).toHaveTextContent('Sếp đã đồng ý lúc 08:30 03/10/2026 (phiên bản cảnh báo 2026-10-03)');
    expect(screen.getByRole('button', { name: 'Rút lại đồng ý' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tôi hiểu rủi ro và đồng ý' })).toBeNull();
  });

  it('đã đồng ý: hiện thời điểm + "Rút lại đồng ý" (có hộp xác nhận) → DELETE, nút đồng ý quay lại', async () => {
    const calls = stub({ gate: gate({ consent: CONSENT, open: true }) });
    renderPage(<SocialWriteRiskPage />);
    expect(await screen.findByTestId('write-consent-info')).toHaveTextContent('Sếp đã đồng ý lúc 08:30 03/10/2026 (phiên bản cảnh báo 2026-10-03)');
    await userEvent.click(screen.getByRole('button', { name: 'Rút lại đồng ý' }));
    const dlg = await screen.findByRole('dialog', { name: 'Rút lại đồng ý?' });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false); // chưa làm gì cho tới khi xác nhận
    await userEvent.click(within(dlg).getByRole('button', { name: 'Rút lại đồng ý' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/social/write-consent'))).toBe(true));
    expect(await screen.findByRole('button', { name: 'Tôi hiểu rủi ro và đồng ý' })).toBeInTheDocument();
  });

  it('sandbox bật: "không cần đồng ý thêm", không có nút đồng ý', async () => {
    stub({ gate: gate({ sandbox: { enabled: true, reason: null, checked_at: '2026-10-03T01:00:00Z' }, open: true }) });
    renderPage(<SocialWriteRiskPage />);
    expect(await screen.findByTestId('write-sandbox-on')).toHaveTextContent('Trình duyệt đang chạy trong sandbox — không cần đồng ý thêm');
    expect(screen.getByTestId('write-sandbox')).toHaveTextContent('Đã bật');
    expect(screen.queryByRole('button', { name: 'Tôi hiểu rủi ro và đồng ý' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rút lại đồng ý' })).toBeNull();
  });

  it('trình duyệt nền chưa chạy → nói rõ, vẫn cho Sếp quyết', async () => {
    stub({ gate: gate({ worker_online: false, sandbox: { enabled: null, reason: null, checked_at: null } }) });
    renderPage(<SocialWriteRiskPage />);
    expect(await screen.findByTestId('write-sandbox')).toHaveTextContent('Trình duyệt nền chưa chạy');
    expect(screen.getByRole('button', { name: 'Tôi hiểu rủi ro và đồng ý' })).toBeInTheDocument();
  });

  it('lỗi API khi đồng ý → câu thân thiện + "Chi tiết kỹ thuật" (mã), không "[object Object]"', async () => {
    stub({ gate: gate(), acceptError: json(409, { status: 409, code: 'SOCIAL_CONSENT_VERSION', title: 'Cảnh báo rủi ro đã được cập nhật — tải lại trang rồi đọc lại' }) });
    const { container } = renderPage(<SocialWriteRiskPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tôi hiểu rủi ro và đồng ý' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Cảnh báo rủi ro đã được cập nhật');
    expect(within(alert).getByText('Chi tiết kỹ thuật')).toBeInTheDocument();
    expect(alert).toHaveTextContent('SOCIAL_CONSENT_VERSION');
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('không tải được cổng → thẻ lỗi có nút thử lại; vai trò khác Owner → "Chỉ Owner dùng được"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(500, { status: 500, code: 'INTERNAL', title: 'Hệ thống gặp lỗi' })));
    const { unmount } = renderPage(<SocialWriteRiskPage />);
    expect(await screen.findByRole('button', { name: /Thử lại/ })).toBeInTheDocument();
    unmount();
    renderPage(<SocialWriteRiskPage />, 'manager');
    expect(await screen.findByText('Chỉ Owner dùng được')).toBeInTheDocument();
  });
});

describe('socialModel — trạng thái việc gửi', () => {
  it('nhãn tiếng Việt cho từng trạng thái', () => {
    expect(writeStatusView({ status: 'queued' }).label).toBe('Đang chờ trình duyệt…');
    expect(writeStatusView({ status: 'running' }).label).toBe('Đang gửi trên Facebook…');
    expect(writeStatusView({ status: 'done', confirmed: true })).toMatchObject({ label: 'Đã gửi', notes: [], terminal: true });
    expect(writeStatusView({ status: 'done', confirmed: false, after_halt: true }).notes).toEqual([
      'Đã gửi trước khi kịp dừng',
      'Đã bấm gửi nhưng chưa thấy hiện trên trang — xem ảnh chụp',
    ]);
    expect(writeStatusView({ status: 'halted' }).label).toBe('Đã dừng bằng Dừng tất cả — chưa gửi gì');
    expect(writeStatusView({ status: 'failed' }).tone).toBe('bad');
  });
  it('định dạng thời điểm đồng ý HH:mm dd/MM/yyyy theo múi giờ tổ chức', () => {
    expect(fmtConsentTime('2026-10-03T01:30:00Z', 'Asia/Ho_Chi_Minh')).toBe('08:30 03/10/2026');
  });
});

describe('SocialPage — thẻ "Gửi trả lời & tin nhắn"', () => {
  const ACC: SocialAccount = {
    id: 'a1', platform: 'facebook_personal', platform_name: 'Facebook cá nhân', mode: 'browser', label: 'Facebook của Sếp',
    external_handle: null, status: 'active', pause_reason: null, has_session: true, session_updated_at: null, last_health: null,
    risk_accepted_at: '2026-09-30T01:00:00Z', risk_version: '2026-09-30', schedule: { enabled: false, times: ['08:00', '17:00'] },
    daily_read_limit: 6, daily_write_limit: 10, writes_today: 3, last_read_at: null, created_at: '2026-09-30T01:00:00Z', active_job: null,
  };
  const WRITES: SocialWriteItem[] = Array.from({ length: 10 }, (_, i) => ({
    job_id: `j${i}`, account_id: 'a1', account_label: 'Facebook của Sếp', action: i % 2 ? 'send_message' : 'reply_comment',
    target_url: `https://www.facebook.com/permalink.php?story_fbid=${i}`, text: 'x', status: i === 0 ? 'failed' : 'done', error: i === 0 ? 'SEND_UNCONFIRMED' : null,
    error_text: i === 0 ? 'Chưa thấy nội dung hiện trên trang.' : null, created_at: `2026-10-03T0${i}:00:00Z`, finished_at: null, has_proof: i > 0, confirmed: true, after_halt: false,
  }));

  function stubSocial(over: { gate?: SocialWriteGate } = {}) {
    const calls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const c = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
        calls.push(c);
        const u = c.url;
        if (u.endsWith('/social/status'))
          return json(200, { halted: false, halted_at: null, worker: { version: 'x', at: '', running: 0 }, hard_rules: [], limits: { reads_per_day_max: 6, read_min_interval_minutes: 10, quiet_hours: [23, 6], concurrency_per_account: 1 } });
        if (u.endsWith('/social/platforms')) return json(200, PLATFORMS);
        if (u.endsWith('/social/accounts') && c.method === 'GET') return json(200, { items: [ACC] });
        if (u.endsWith('/social/write-gate')) return json(200, over.gate ?? gate());
        if (/\/social\/writes/.test(u)) return json(200, { items: WRITES });
        if (/\/social\/accounts\/a1$/.test(u) && c.method === 'PATCH') return json(200, { ...ACC, daily_write_limit: (c.body as { daily_write_limit: number }).daily_write_limit });
        return json(404, { status: 404, code: 'NOT_FOUND', title: 'Không tồn tại' });
      }),
    );
    return calls;
  }

  it('cổng Khoá + lý do, link trang cảnh báo, "Hôm nay đã gửi x/y", chọn giới hạn → PATCH, 10 lần gửi gần đây có "Xem ảnh chụp"; mô tả công tắc dừng', async () => {
    const calls = stubSocial();
    renderPage(<SocialPage />);
    const card = await screen.findByTestId('social-write-gate');
    const state = await within(card).findByTestId('social-write-gate-state');
    expect(state).toHaveTextContent('Khoá');
    expect(state).toHaveTextContent('Máy chủ không cho bật vùng cách ly của trình duyệt.');
    expect(within(card).getByRole('link', { name: /Đọc cảnh báo rủi ro/ })).toHaveAttribute('href', '/social/ghi-facebook');
    expect(await within(card).findByText('Hôm nay đã gửi 3/10')).toBeInTheDocument();
    const recent = await within(card).findByRole('list', { name: 'Lần gửi gần đây' });
    expect(within(recent).getAllByRole('listitem')).toHaveLength(10);
    expect(within(recent).getAllByRole('button', { name: 'Xem ảnh chụp' })).toHaveLength(9);
    expect(recent).toHaveTextContent('Chưa thấy nội dung hiện trên trang.');
    expect(screen.getByTestId('social-kill-switch')).toHaveTextContent('Đóng ngay mọi trình duyệt nền, chặn cả ĐỌC và GỬI. Bật lại cần mã PIN.');

    const select = within(card).getByLabelText('Giới hạn gửi/ngày');
    expect(within(select).getAllByRole('option')).toHaveLength(20);
    await userEvent.selectOptions(select, '5');
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ daily_write_limit: 5 }));

    await userEvent.click(within(recent).getAllByRole('button', { name: 'Xem ảnh chụp' })[0]);
    expect(await screen.findByAltText('Ảnh chụp bằng chứng lần gửi')).toHaveAttribute('src', '/api/v1/social/jobs/j1/proof');
  });

  it('cổng Mở (đã đồng ý) → "Mở"', async () => {
    stubSocial({ gate: gate({ consent: CONSENT, open: true }) });
    renderPage(<SocialPage />);
    const state = await screen.findByTestId('social-write-gate-state');
    await waitFor(() => expect(state).toHaveAttribute('data-open', 'true'));
    expect(state).toHaveTextContent('Mở');
    expect(state).toHaveTextContent('Sếp đã đồng ý rủi ro');
  });
});
