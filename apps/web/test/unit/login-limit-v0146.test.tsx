import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LoginPage } from '../../src/pages/LoginPage';

/** v0.1.46: đăng nhập sai quá nhiều lần → 429 LOGIN_RATE_LIMITED, câu thân thiện + "Chi tiết kỹ thuật" (mã lỗi). */

const problem = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json' } });

function submit() {
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.vn' } });
  fireEvent.change(screen.getByLabelText('Mật khẩu'), { target: { value: 'mat-khau-sai-123' } });
  fireEvent.click(screen.getByRole('button', { name: /Đăng nhập/ }));
}

describe('LoginPage giới hạn đăng nhập', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('429 LOGIN_RATE_LIMITED: câu thân thiện, số phút và mã lỗi trong Chi tiết kỹ thuật', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problem(429, { status: 429, code: 'LOGIN_RATE_LIMITED', title: 'x', retry_after_s: 600 })));
    submit();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Đăng nhập sai quá nhiều lần'));
    expect(screen.getByRole('alert').textContent).toContain('10 phút');
    const details = screen.getByText('Chi tiết kỹ thuật').closest('details');
    expect(details?.textContent).toContain('LOGIN_RATE_LIMITED');
  });

  it('INVALID_CREDENTIALS giữ câu cũ, không có Chi tiết kỹ thuật', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problem(401, { status: 401, code: 'INVALID_CREDENTIALS', title: 'x' })));
    submit();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Email hoặc mật khẩu không đúng.'));
    expect(screen.queryByText('Chi tiết kỹ thuật')).toBeNull();
  });
});
