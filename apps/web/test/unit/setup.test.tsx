import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { SetupState } from '@gen-harness/contracts';
import {
  addressingPreview,
  isComplete,
  passwordStrength,
  step1Errors,
  step2Errors,
  step3Errors,
  validateEmail,
  validatePassword,
  validatePin,
  validatePinConfirm,
} from '../../src/setup/validation';
import { isReachable, mergeSteps } from '../../src/setup/stepState';
import { SetupPage } from '../../src/setup/SetupPage';
import { queryClient } from '../../src/lib/queryClient';

describe('setup validation', () => {
  it('step 1 needs a token', () => {
    expect(isComplete(step1Errors({ token: '', language: 'vi', mode: 'empty' }))).toBe(false);
    expect(isComplete(step1Errors({ token: '  ', language: 'vi', mode: 'empty' }))).toBe(false);
    expect(isComplete(step1Errors({ token: 'GH-1', language: 'en', mode: 'sample' }))).toBe(true);
  });

  it('passwords need ≥ 12 characters', () => {
    expect(validatePassword('short')).toMatch(/12 ký tự/);
    expect(validatePassword('a'.repeat(11))).not.toBeNull();
    expect(validatePassword('đủ-mười-hai!')).toBeNull();
  });

  it('PIN is exactly 6 digits and both entries must match', () => {
    expect(validatePin('12345')).not.toBeNull();
    expect(validatePin('12345a')).not.toBeNull();
    expect(validatePin('246810')).toBeNull();
    expect(validatePinConfirm('246810', '246811')).toMatch(/chưa khớp/);
    expect(validatePinConfirm('246810', '2468')).not.toBeNull();
    expect(validatePinConfirm('246810', '246810')).toBeNull();
  });

  it('email format', () => {
    expect(validateEmail('')).not.toBeNull();
    expect(validateEmail('sep@')).not.toBeNull();
    expect(validateEmail('sep@genesis.vn')).toBeNull();
  });

  it('step 2 completes only when every field is valid', () => {
    const ok = { token: 't', display_name: 'Anh Cơ La', email: 'a@b.vn', password: 'mat-khau-dai-lam', pin: '246810', pin_confirm: '246810' };
    expect(isComplete(step2Errors(ok))).toBe(true);
    expect(Object.keys(step2Errors({ ...ok, pin_confirm: '000000' }))).toEqual(['pin_confirm']);
    expect(Object.keys(step2Errors({ ...ok, password: 'ngan' }))).toEqual(['password']);
    expect(Object.keys(step2Errors({ ...ok, token: '' }))).toEqual(['token']);
  });

  it('step 3 requires all five fields', () => {
    const ok = { org_name: 'Genesis', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND', self_name: 'Anh', bot_calls_me: 'Sếp' };
    expect(isComplete(step3Errors(ok))).toBe(true);
    expect(Object.keys(step3Errors({ ...ok, org_name: ' ' }))).toEqual(['org_name']);
  });

  it('strength meter grows with length and variety, capped below 12 chars', () => {
    expect(passwordStrength('').score).toBe(0);
    expect(passwordStrength('Ab1!Ab1!').score).toBeLessThanOrEqual(1);
    expect(passwordStrength('mot-cau-rat-dai-de-nho-2026').score).toBeGreaterThanOrEqual(3);
    expect(passwordStrength('aaaaaaaaaaaa').tone).toBe('bad');
  });

  it('addressing preview uses both names live', () => {
    expect(addressingPreview('Chị', 'Chị Hai')).toContain('Dạ Chị Hai');
    expect(addressingPreview('Chị', 'Chị Hai')).toContain('“Sáng nay chị cần xem gì?”');
    expect(addressingPreview('', '')).toContain('Dạ Sếp');
  });
});

const stateAt = (current: number, done: number[] = [], skipped: number[] = []): SetupState => ({
  finished: false,
  current_step: current,
  steps: Array.from({ length: 12 }, (_, i) => ({
    n: i + 1,
    key: `s${i + 1}`,
    title: `Bước ${i + 1}`,
    required: ![10, 11].includes(i + 1),
    status: done.includes(i + 1) ? 'done' : skipped.includes(i + 1) ? 'skipped' : i + 1 === current ? 'doing' : 'todo',
  })),
});

describe('step state', () => {
  it('marks the current step as doing and keeps server titles', () => {
    const s = stateAt(2, [1]);
    s.steps[1].status = 'todo';
    const merged = mergeSteps(s);
    expect(merged[1].status).toBe('doing');
    expect(merged[0].status).toBe('done');
    expect(merged[3].title).toBe('Bước 4');
  });

  it('only settled or not-yet-passed steps are reachable', () => {
    const s = stateAt(3, [1, 2]);
    expect(isReachable(1, s)).toBe(true);
    expect(isReachable(3, s)).toBe(true);
    expect(isReachable(4, s)).toBe(false);
  });
});

// ── the wizard against a stubbed API ──────────────────────────────────────
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => handler(String(url), init ?? {}));
  vi.stubGlobal('fetch', spy);
  return spy;
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function renderSetup(path = '/setup') {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <SetupPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<SetupPage>', () => {
  beforeEach(() => {
    queryClient.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('loads progress from GET /setup/state and shows the 12-step rail', async () => {
    mockFetch(() => json(200, stateAt(1)));
    renderSetup();
    expect(await screen.findByRole('heading', { name: 'Bước 1' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    expect(screen.getByText('Bước 1/12')).toBeInTheDocument();
  });

  it('step 1: token prefilled from ?token=, Tiếp tục enabled only with a token, PUT then advances', async () => {
    const user = userEvent.setup();
    let state = stateAt(1);
    const fetchSpy = mockFetch((url, init) => {
      if (url.endsWith('/setup/steps/1') && init.method === 'PUT') {
        state = stateAt(2, [1]);
        return json(200, state);
      }
      return json(200, state);
    });
    renderSetup('/setup?token=GH-SETUP-7Q4K');
    const token = await screen.findByLabelText('Mã thiết lập');
    expect(token).toHaveValue('GH-SETUP-7Q4K');
    const next = screen.getByRole('button', { name: /Tiếp tục/ });
    expect(next).toBeEnabled();

    await user.clear(token);
    expect(next).toBeDisabled();
    await user.tab(); // leave the field → inline error
    expect(await screen.findByText(/Nhập mã thiết lập/)).toBeInTheDocument();

    await user.type(token, 'GH-SETUP-7Q4K');
    await user.click(screen.getByLabelText(/Dùng dữ liệu mẫu/));
    await user.click(screen.getByRole('radio', { name: 'English' }));
    await user.click(next);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Bước 2' })).toBeInTheDocument());
    const put = fetchSpy.mock.calls.find(([u, i]) => String(u).endsWith('/setup/steps/1') && i?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]!.body))).toEqual({ token: 'GH-SETUP-7Q4K', language: 'en', mode: 'sample' });
    expect(sessionStorage.getItem('gh_setup_token')).toBe('GH-SETUP-7Q4K');
  });

  it('step 1: 403 SETUP_TOKEN_INVALID shows an 11px inline error on the field', async () => {
    const user = userEvent.setup();
    mockFetch((url, init) =>
      url.endsWith('/setup/steps/1') && init.method === 'PUT'
        ? json(403, { status: 403, code: 'SETUP_TOKEN_INVALID' })
        : json(200, stateAt(1)),
    );
    renderSetup('/setup?token=WRONG');
    await user.click(await screen.findByRole('button', { name: /Tiếp tục/ }));
    const err = await screen.findByText(/không hợp lệ hoặc đã hết hạn/);
    expect(err).toHaveClass('gh-field__error');
    expect(screen.getByLabelText('Mã thiết lập')).toHaveAttribute('aria-invalid', 'true');
  });

  it('step 2: Tiếp tục stays disabled until password ≥ 12 and both PINs match', async () => {
    const user = userEvent.setup();
    sessionStorage.setItem('gh_setup_token', 'GH-1');
    mockFetch(() => json(200, stateAt(2, [1])));
    renderSetup();
    await screen.findByRole('heading', { name: 'Bước 2' });
    const next = screen.getByRole('button', { name: /Tiếp tục/ });
    await user.type(screen.getByLabelText('Tên hiển thị'), 'Anh Cơ La');
    await user.type(screen.getByLabelText('Email'), 'owner@genesis.vn');
    await user.type(screen.getByLabelText('Mật khẩu'), 'ngan');
    await user.tab();
    expect(await screen.findByText(/ít nhất 12 ký tự \(hiện 4\)/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Mật khẩu'), '-nhung-da-du-dai');

    await user.click(screen.getByLabelText('Mã PIN (6 số) — chữ số 1/6'));
    await user.keyboard('246810');
    await user.click(screen.getByLabelText('Nhập lại PIN — chữ số 1/6'));
    await user.keyboard('246811');
    expect(next).toBeDisabled();
    await user.tab();
    expect(await screen.findByText('Hai lần nhập PIN chưa khớp.')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Nhập lại PIN — chữ số 6/6'));
    await user.keyboard('{Backspace}0');
    expect(next).toBeEnabled();
    expect(screen.getByText('yêu cầu PIN khi')).toBeInTheDocument();
  });

  it('optional steps can be skipped via POST /setup/steps/{n}/skip; required ones cannot', async () => {
    const user = userEvent.setup();
    let state = stateAt(10, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    mockFetch((url, init) => {
      if (url.endsWith('/setup/steps/10/skip') && init.method === 'POST') {
        state = stateAt(11, [1, 2, 3, 4, 5, 6, 7, 8, 9], [10]);
      }
      return json(200, state);
    });
    renderSetup();
    await screen.findByRole('heading', { name: 'Bước 10' });
    expect(screen.getByText('Sắp có')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tiếp tục/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Bỏ qua' }));
    expect(await screen.findByRole('heading', { name: 'Bước 11' })).toBeInTheDocument();
    expect(screen.getByText('bỏ qua')).toBeInTheDocument();
    // Bước 12 is required: no skip button
    queryClient.setQueryData(['setup', 'state'], stateAt(12, [1, 2, 3, 4, 5, 6, 7, 8, 9, 11], [10]));
    expect(await screen.findByRole('heading', { name: 'Bước 12' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bỏ qua' })).not.toBeInTheDocument();
  });

  it('shows an error state with Thử lại when the state cannot load', async () => {
    mockFetch(() => json(503, { status: 503, title: 'Service unavailable' }));
    queryClient.setDefaultOptions({ queries: { retry: false } });
    renderSetup();
    expect(await screen.findByText('Không tải được trạng thái thiết lập', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Thử lại/ })).toBeInTheDocument();
  });
});
