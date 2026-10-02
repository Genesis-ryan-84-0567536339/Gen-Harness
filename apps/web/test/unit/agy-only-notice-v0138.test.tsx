/**
 * v0.1.38 (review F-22): chuỗi model chỉ có Antigravity CLI (agy chỉ cho Gen của Sếp). Máy chủ trả 503
 * MODEL_UNAVAILABLE với title/detail riêng (gh/providers/router.py::AGY_ONLY_TITLE/AGY_ONLY_HINT) — web phải hiện đúng
 * câu đó (không phải "Chưa có model AI hoạt động…"), nút dẫn tới Agent & Model (/api) chứ không về bước 4 (agy "sẵn
 * sàng" ⇒ Owner đi vòng). Áp dụng cho bước 8 (thử trò chuyện), dịch và soạn lại bản nháp.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError, type DraftDetail, type SetupState } from '@gen-harness/contracts';
import { GuideStepPage } from '../../src/guide/GuideStepPage';
import { errorText, isAgyOnlyUnavailable } from '../../src/lib/errorText';
import { AGY_ONLY_TEXT, MODEL_UNAVAILABLE_TEXT } from '../../src/lib/friendlyError';
import { queryClient } from '../../src/lib/queryClient';
import { ActionError, CardError } from '../../src/screens/common';
import { WorkbenchScreen } from '../../src/screens/queue/WorkbenchScreen';

// Chuỗi THẬT của máy chủ (gh/providers/router.py).
const AGY_REASON =
  'Antigravity CLI chỉ dùng cho Gen — trợ lý quản trị (Gen của Sếp). Sàng lọc tin và trực việc phải dùng nguồn khác (khoá API hoặc Claude Code CLI) — luật an toàn, không tắt được.';
const AGY_TITLE = 'Agent cần nguồn AI khác Antigravity CLI (chỉ dành cho Gen của Sếp) — thêm khoá API hoặc Claude Code CLI';
const AGY_HINT = 'Antigravity CLI chỉ dùng cho Gen của Sếp. Vào Agent & Model thêm khoá API hoặc Claude Code CLI rồi gán model đó cho agent này.';
const GENERIC_HINT = 'Chưa có model AI nào hoạt động — vào Agent & Model (Hướng dẫn bước 4) để chọn hoặc sửa model.';

const agyErr = (reasons: string[] = [AGY_REASON]) =>
  new ApiError(503, { title: AGY_TITLE, detail: AGY_HINT, code: 'MODEL_UNAVAILABLE', reasons } as never);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  document.cookie = 'gh_csrf=test-csrf';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('errorText / thẻ lỗi — chuỗi chỉ có Antigravity CLI', () => {
  it('errorText: câu máy chủ (title + hướng dẫn), không phải câu chung', () => {
    expect(isAgyOnlyUnavailable(agyErr())).toBe(true);
    expect(errorText(agyErr())).toBe(`${AGY_TITLE}. ${AGY_HINT}`);
    // Nhân viên: reasons đã lọc rỗng — vẫn nhận ra nhờ title.
    expect(errorText(agyErr([]))).toBe(`${AGY_TITLE}. ${AGY_HINT}`);
    const generic = new ApiError(503, { title: 'Chưa có model nào chạy được để dịch', detail: GENERIC_HINT, code: 'MODEL_UNAVAILABLE', reasons: ['alpha: 429'] } as never);
    expect(isAgyOnlyUnavailable(generic)).toBe(false);
    expect(errorText(generic)).toBe(MODEL_UNAVAILABLE_TEXT);
  });

  it('CardError/ActionError: nút "Thêm nguồn AI" → /api, lý do trong "Chi tiết kỹ thuật"', () => {
    for (const ui of [<CardError key="c" error={agyErr()} />, <ActionError key="a" error={agyErr()} />]) {
      const { unmount } = render(<MemoryRouter>{ui}</MemoryRouter>);
      const box = screen.getByTestId('model-unavailable');
      expect(box).toHaveTextContent(AGY_TITLE);
      expect(box).not.toHaveTextContent(MODEL_UNAVAILABLE_TEXT);
      expect(within(box).getByRole('link', { name: /Thêm nguồn AI/ })).toHaveAttribute('href', '/api');
      expect(within(box).queryByRole('link', { name: /Chọn model/ })).toBeNull();
      expect(within(box).getByText('Chi tiết kỹ thuật')).toBeInTheDocument();
      unmount();
    }
  });

  it('ActionError lỗi thường → dòng InlineError', () => {
    render(<MemoryRouter><ActionError error={new ApiError(409, { title: 'Bản nháp đã được duyệt', code: 'CONFLICT' } as never)} /></MemoryRouter>);
    expect(screen.getByRole('alert')).toHaveTextContent('Bản nháp đã được duyệt');
  });
});

// ── /guide/8 ─────────────────────────────────────────────────────────────
const state: SetupState = {
  finished: true,
  current_step: 12,
  steps: Array.from({ length: 12 }, (_, i) => ({
    n: i + 1, key: `s${i + 1}`, title: i + 1 === 8 ? 'Agent đầu tiên' : `Bước ${i + 1}`,
    required: i + 1 <= 4 || i + 1 === 12, status: i + 1 <= 4 || i + 1 === 12 ? 'done' : 'todo', available: true,
  })),
};

describe('/guide/8 — thử trò chuyện khi chỉ có Antigravity CLI', () => {
  it('hiện câu máy chủ (try_error = AGY_ONLY_HINT) và nút tới /api', async () => {
    queryClient.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/setup/steps/8') && init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as { name: string };
          return json(200, { ...state, agent: { id: 'a1', name: body.name, try_reply: null, try_error: AGY_HINT, try_error_code: 'MODEL_UNAVAILABLE', try_reasons: [AGY_REASON] } });
        }
        if (u.includes('/setup/state')) return json(200, state);
        return json(200, []);
      }),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/guide/8']}>
          <Routes>
            <Route path="/guide/:n" element={<GuideStepPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Tên agent'), 'Thư ký');
    await user.type(screen.getByLabelText(/Vai trò/), 'Nhắc lịch');
    await user.click(screen.getByRole('button', { name: /Tiếp tục/ }));
    const box = await screen.findByTestId('model-unavailable');
    expect(box).toHaveTextContent(AGY_HINT);
    expect(box).not.toHaveTextContent(MODEL_UNAVAILABLE_TEXT);
    expect(within(box).getByRole('link', { name: /Thêm nguồn AI/ })).toHaveAttribute('href', '/api');
  });
});

// ── Bàn duyệt: dịch / soạn lại ─────────────────────────────────────────
const DRAFT: DraftDetail = {
  id: 'd1', code: 'DR-1', kind: 'message', kind_label: 'Tin nhắn', title: 'Trả lời khách', agent: null, created_by: null,
  created_at: '2026-10-01T08:00:00Z', status: 'pending', hold_reason: null, subject: null,
  paragraphs: ['Chào anh'], text: 'Chào anh', lang: 'vi', target: null, amount_vnd: null, autonomy_level: 4,
  flags: { writes_external: true, personnel_related: false, over_threshold: false }, approve_label: 'Duyệt & gửi',
  sources: [], context: [], side_actions: [], decision: null, send_result: null, versions: [],
};

function renderWorkbench() {
  const agyBody = { type: 'about:blank', title: AGY_TITLE, status: 503, detail: AGY_HINT, code: 'MODEL_UNAVAILABLE', reasons: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/drafts/d1/translate') || u.includes('/drafts/d1/regenerate')) return json(503, agyBody);
      if (u.includes('/drafts/d1') && (init?.method ?? 'GET') === 'GET') return json(200, DRAFT);
      if (u.includes('/drafts')) return json(200, { items: [DRAFT], next_cursor: null, total: 1 });
      return json(200, []);
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/workbench?id=d1']}>
        <WorkbenchScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Bàn duyệt — chuỗi chỉ có Antigravity CLI', () => {
  it('Dịch lỗi → câu máy chủ + nút /api', async () => {
    renderWorkbench();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Dịch/ }));
    await user.click(screen.getByRole('radio', { name: 'EN' }));
    const box = await screen.findByTestId('model-unavailable');
    expect(box).toHaveTextContent(AGY_TITLE);
    expect(within(box).getByRole('link', { name: /Thêm nguồn AI/ })).toHaveAttribute('href', '/api');
  });

  it('Soạn lại lỗi → không còn im lặng: hiện câu máy chủ', async () => {
    renderWorkbench();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Soạn lại/ }));
    const box = await screen.findByTestId('model-unavailable');
    expect(box).toHaveTextContent(AGY_TITLE);
    expect(document.body.textContent).not.toContain('[object Object]');
  });

  it('AGY_ONLY_TEXT là câu dự phòng khi thiếu title', () => {
    expect(errorText(new ApiError(503, { code: 'MODEL_UNAVAILABLE', reasons: [AGY_REASON] } as never))).toBe(AGY_ONLY_TEXT);
  });
});
