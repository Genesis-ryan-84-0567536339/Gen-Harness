import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type {
  CareIssuesPage,
  CareResponseTimes,
  CareScenariosPage,
  PeopleReviewFullDetail,
  PeopleReviewLogItem,
  PeopleReviewPage,
} from '@gen-harness/contracts';
import { CareScreen } from '../../src/screens/people/CareScreen';
import { PeopleScreen } from '../../src/screens/people/PeopleScreen';
import { queryClient } from '../../src/lib/queryClient';

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
});

const PERSON = { id: 'p-tu', code: 'PER-2205', name: 'Phạm Anh Tú', type: 'staff' as const, org_name: null };

const FULL_ITEM = {
  id: 'rev-1',
  person: PERSON,
  period_start: '2026-09-17',
  period_end: '2026-09-23',
  score: 54,
  trend: 'down' as const,
  signal: 'Hai lần hứa mốc giao hàng rồi không cập nhật lại.',
  recommendation: 'Bật nhắc tự động cho mọi lời hứa có mốc thời gian của người này.',
  evidence: [{ type: 'meaning_unit', id: 'mu-1' }],
  visibility: 'owner' as const,
  created_at: '2026-09-24T01:00:00Z',
  overridden: false,
  overridden_by: null,
  overridden_at: null,
  override_reason: null,
  supersedes_id: null,
};

const FULL_DETAIL: PeopleReviewFullDetail = {
  ...FULL_ITEM,
  history: [{ id: 'rev-1', score: 54, trend: 'down', created_at: '2026-09-24T01:00:00Z', overridden_by: null, override_reason: null }],
  disputes: [
    {
      id: 'disp-1', review_id: 'rev-1', raised_by: { id: 'u-owner', name: 'Anh Cơ La (Ryan)' },
      body: 'Khách chủ động im lặng, không phải do chậm cập nhật.', status: 'open', resolution: null, resolved_by: null, resolved_at: null,
      created_at: '2026-09-24T00:00:00Z',
    },
  ],
};

describe('Đánh giá con người — Q4 (docs/PLAN.md)', () => {
  it('Owner (nhánh full): thấy điểm/tín hiệu/khuyến nghị, sửa điểm tay giữ lịch sử', async () => {
    const user = userEvent.setup();
    const overridden: PeopleReviewFullDetail = { ...FULL_DETAIL, id: 'rev-2', score: 70, overridden: true, overridden_by: { id: 'u-owner', name: 'Anh Cơ La (Ryan)' }, overridden_at: '2026-09-24T02:00:00Z', override_reason: 'Xem lại chứng cứ, khách chủ động im lặng.', supersedes_id: 'rev-1', history: [{ id: 'rev-2', score: 70, trend: 'down', created_at: '2026-09-24T02:00:00Z', overridden_by: { id: 'u-owner', name: 'Anh Cơ La (Ryan)' }, override_reason: 'Xem lại chứng cứ, khách chủ động im lặng.' }, FULL_DETAIL.history[0]] };

    mockFetch((c) => {
      if (c.method === 'PATCH' && c.url.includes('/people/reviews/rev-1')) return json(200, overridden);
      if (c.url.includes('/people/reviews/rev-2')) return json(200, overridden);
      if (c.url.includes('/people/reviews/rev-1')) return json(200, FULL_DETAIL);
      if (c.url.includes('/people/reviews')) return json(200, { items: [FULL_ITEM], next_cursor: null, total: 1 } satisfies PeopleReviewPage);
      return json(404);
    });

    renderScreen(<PeopleScreen />);
    expect(await screen.findByText('Phạm Anh Tú')).toBeInTheDocument();
    expect(screen.getByText('54')).toBeInTheDocument();
    expect(screen.getByText(/Hai lần hứa mốc giao hàng/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sửa điểm tay' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // Lịch sử đã có sẵn bản hệ thống.
    expect(within(screen.getByRole('dialog')).getByText('tự động (rules+model)')).toBeInTheDocument();

    const scoreInput = screen.getByLabelText('Điểm mới (0–100)');
    await user.clear(scoreInput);
    await user.type(scoreInput, '70');
    await user.type(screen.getByPlaceholderText('Bắt buộc — ghi rõ vì sao sửa điểm'), 'Xem lại chứng cứ, khách chủ động im lặng.');
    await user.click(screen.getByRole('button', { name: 'Lưu điểm mới' }));

    await waitFor(() => expect(within(screen.getByRole('dialog')).getAllByText('70').length).toBeGreaterThan(0));
    expect(within(screen.getByRole('dialog')).getAllByText(/sửa tay · Anh Cơ La \(Ryan\)/).length).toBeGreaterThan(0);
  });

  it('mở phản biện và giải quyết — không tự đổi điểm', async () => {
    const user = userEvent.setup();
    let disputeStatus: 'open' | 'resolved' = 'open';
    mockFetch((c) => {
      if (c.method === 'PATCH' && c.url.includes('/disputes/disp-1')) {
        disputeStatus = 'resolved';
        return json(200, { ...FULL_DETAIL.disputes[0], status: 'resolved', resolution: 'Đồng ý, không trừ điểm lần này.', resolved_by: { id: 'u-owner', name: 'Anh Cơ La (Ryan)' }, resolved_at: '2026-09-24T03:00:00Z' });
      }
      if (c.method === 'POST' && c.url.includes('/rev-1/disputes')) {
        return json(201, { id: 'disp-2', review_id: 'rev-1', raised_by: { id: 'u-owner', name: 'Anh Cơ La (Ryan)' }, body: 'Phản biện mới', status: 'open', resolution: null, resolved_by: null, resolved_at: null, created_at: '2026-09-24T04:00:00Z' });
      }
      if (c.url.includes('/people/reviews/rev-1')) {
        return json(200, disputeStatus === 'open' ? FULL_DETAIL : { ...FULL_DETAIL, disputes: [{ ...FULL_DETAIL.disputes[0], status: 'resolved', resolution: 'Đồng ý, không trừ điểm lần này.' }] });
      }
      if (c.url.includes('/people/reviews')) return json(200, { items: [FULL_ITEM], next_cursor: null, total: 1 } satisfies PeopleReviewPage);
      return json(404);
    });

    renderScreen(<PeopleScreen />);
    await user.click(await screen.findByRole('button', { name: 'Sửa điểm tay' }));
    expect(await screen.findByText(/Khách chủ động im lặng/)).toBeInTheDocument();

    const [resolutionBox] = screen.getAllByPlaceholderText('Ghi lý do xử lý');
    await user.type(resolutionBox, 'Đồng ý, không trừ điểm lần này.');
    await user.click(screen.getByRole('button', { name: 'Chấp nhận' }));

    await waitFor(() => expect(screen.getByText('đã chấp nhận')).toBeInTheDocument());
    // Giải quyết phản biện không tự đổi điểm — điểm hiện tại vẫn 54 (khoá cứng 2).
    expect(within(screen.getByRole('dialog')).getAllByText('54').length).toBeGreaterThan(0);
  });

  it('Auditor (nhánh log): chỉ thấy nhật ký ai đã xem, KHÔNG thấy điểm/tín hiệu/khuyến nghị/chứng cứ', async () => {
    const user = userEvent.setup();
    const LOG_ITEM: PeopleReviewLogItem = {
      id: 'rev-1', person: PERSON, period_start: '2026-09-17', period_end: '2026-09-23', created_at: '2026-09-24T01:00:00Z',
      has_content: true, dispute_count: 1,
      viewed_by: [{ at: '2026-09-24T01:30:00Z', user: { id: 'u-owner', name: 'Anh Cơ La (Ryan)' }, action: 'people_review.viewed' }],
    };
    mockFetch((c) => {
      if (c.url.includes('/people/reviews/rev-1')) return json(200, { ...LOG_ITEM, viewed_by: [...LOG_ITEM.viewed_by, { at: '2026-09-24T02:00:00Z', user: { id: 'u-auditor', name: 'Anh Minh Kiểm' }, action: 'people_review.audit_viewed' }] });
      if (c.url.includes('/people/reviews')) return json(200, { items: [LOG_ITEM], next_cursor: null, total: 1 } satisfies PeopleReviewPage);
      return json(404);
    });

    renderScreen(<PeopleScreen />);
    expect(await screen.findByText('Phạm Anh Tú')).toBeInTheDocument();
    expect(screen.getByText('Đã có đánh giá')).toBeInTheDocument();
    // Không có điểm, tín hiệu, khuyến nghị, nút "Vì sao"/"Xem chứng cứ" — chỉ nút xem nhật ký.
    expect(screen.queryByText('54')).not.toBeInTheDocument();
    expect(screen.queryByText(/Hai lần hứa mốc giao hàng/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Xem chứng cứ/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sửa điểm tay' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Xem nhật ký ai đã xem' }));
    expect(await screen.findByText('Anh Cơ La (Ryan)')).toBeInTheDocument();
    expect(screen.getByText('Anh Minh Kiểm')).toBeInTheDocument();
    expect(screen.getByText('people_review.audit_viewed')).toBeInTheDocument();
  });

  it('Manager (chặn ở backend): 403 → thông báo không có quyền, không crash', async () => {
    mockFetch(() => json(403, { type: 'about:blank', title: 'Vai trò không có quyền này', status: 403, code: 'FORBIDDEN' }));
    renderScreen(<PeopleScreen />);
    expect(await screen.findByText('Vai trò của bạn không có quyền làm thao tác này.')).toBeInTheDocument();
  });
});

describe('Chất lượng chăm sóc', () => {
  const RESPONSE: CareResponseTimes = {
    from: '2026-08-25T00:00:00Z',
    to: '2026-09-24T00:00:00Z',
    items: [
      { staff: { id: 'p-tu', code: 'PER-2205', name: 'Phạm Anh Tú', type: 'staff', org_name: null }, fast: 0, normal: 4, slow: 2, total_answered: 6, fast_pct: 0, avg_minutes: 46.5 },
      { staff: { id: 'p-dang', code: 'PER-2203', name: 'Vũ Hải Đăng', type: 'staff', org_name: null }, fast: 5, normal: 1, slow: 0, total_answered: 6, fast_pct: 83.3, avg_minutes: 11.3 },
    ],
    totals: { fast: 5, normal: 5, slow: 2, total_answered: 12, fast_pct: 41.7 },
    unattended: 3,
  };
  const ISSUES: CareIssuesPage = {
    items: [
      { kind: 'broken_promise', subject: { id: 'p-tu', code: 'PER-2205', name: 'Phạm Anh Tú', type: 'staff', org_name: null }, count: 2, repeated: true, last_at: '2026-09-21T00:00:00Z' },
      { kind: 'abandoned_customer', subject: { id: 'p-ngoc', code: 'PER-2301', name: 'Nguyễn Thị Ngọc', type: 'customer', org_name: null }, count: 3, repeated: true, last_at: '2026-09-19T00:00:00Z' },
    ],
    next_cursor: null,
    total: 2,
  };
  const SCENARIOS: CareScenariosPage = {
    items: [
      {
        deal: { id: 'd1', code: 'DEA-0201', amount_vnd: 180_000_000, status: 'won', won_at: '2026-09-20T00:00:00Z', opportunity_id: null },
        person: { id: 'p-ngoc', code: 'PER-2301', name: 'Nguyễn Thị Ngọc', type: 'customer', org_name: null },
        response: { fast: 5, normal: 1, slow: 0, unanswered: 0, fast_pct: 83.3, avg_minutes: 9.4 },
        broken_promises: 0,
        note: 'Kịch bản thắng: phản hồi nhanh 83%, không có lời hứa bị vỡ.',
      },
    ],
    next_cursor: null,
    total: 1,
    summary: { won: { count: 1, avg_fast_pct: 83.3, avg_broken_promises: 0 }, lost: { count: 0, avg_fast_pct: 0, avg_broken_promises: 0 } },
  };

  it('hiện lưới phản hồi theo khung giờ, lỗi chăm sóc lặp lại và kịch bản thắng/mất đúng seed', async () => {
    mockFetch((c) => {
      if (c.url.includes('/care/response-times')) return json(200, RESPONSE);
      if (c.url.includes('/care/repeated-issues')) return json(200, ISSUES);
      if (c.url.includes('/care/scenarios')) return json(200, SCENARIOS);
      return json(404);
    });
    renderScreen(<CareScreen />);

    // Lưới phản hồi theo khung giờ, theo nhân viên (Phạm Anh Tú xuất hiện cả ở lưới lẫn ở lỗi lặp lại).
    expect((await screen.findAllByText('Phạm Anh Tú')).length).toBeGreaterThan(0);
    expect(screen.getByText('Vũ Hải Đăng')).toBeInTheDocument();

    // Lỗi chăm sóc lặp lại (nhãn "Hứa rồi quên" lặp lại ở cả ô KPI lẫn dòng lỗi — cố ý, cùng nguồn dữ liệu).
    expect(screen.getAllByText('Hứa rồi quên').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Khách bị bỏ rơi').length).toBeGreaterThan(0);
    expect(screen.getAllByText('lặp lại').length).toBeGreaterThan(0);

    // Kịch bản thắng/mất — liên hệ deal, có đường dẫn sang /deals.
    expect(screen.getByText('DEA-0201')).toBeInTheDocument();
    expect(screen.getByText(/Kịch bản thắng: phản hồi nhanh 83%/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Nguyễn Thị Ngọc · xem deal/ })).toHaveAttribute('href', '/deals');

    // Không có endpoint KPI riêng — 5 ô KPI tính từ response-times + repeated-issues (không hardcode).
    expect(screen.getByText('Khách chưa ai trả lời')).toBeInTheDocument();
  });
});
