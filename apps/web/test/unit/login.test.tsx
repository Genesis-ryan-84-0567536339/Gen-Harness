import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LoginPage } from '../../src/pages/LoginPage';

describe('LoginPage', () => {
  it('chỉ lệnh genh reset-password khi quên mật khẩu', () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Quên mật khẩu\? Trên máy chủ chạy:/)).toBeTruthy();
    expect(screen.getByText('~/.gen-harness/bin/genh reset-password').tagName).toBe('CODE');
  });
});
