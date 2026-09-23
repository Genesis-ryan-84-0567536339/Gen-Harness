import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '@gen-harness/contracts';
import { Button, TextField } from '@gen-harness/ui';
import { api } from '../lib/api';
import { qk } from '../lib/queries';
import { queryClient } from '../lib/queryClient';
import { validateEmail } from '../setup/validation';
import { Logo } from '../shell/Logo';
import { safeNext } from '../lib/safeNext';

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState<{ email?: boolean; password?: boolean }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Đăng nhập · Gen-Harness';
  }, []);

  const emailError = touched.email ? validateEmail(email) : null;
  const passwordError = touched.password && !password ? 'Nhập mật khẩu.' : null;
  const canSubmit = !validateEmail(email) && password.length > 0 && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched({ email: true, password: true });
    if (!canSubmit) return;
    setBusy(true);
    setFormError(null);
    try {
      const me = await api.auth.login({ email: email.trim(), password });
      queryClient.setQueryData(qk.me, me);
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') setFormError('Email hoặc mật khẩu không đúng.');
      else if (err instanceof ApiError && err.status === 0) setFormError('Không kết nối được máy chủ. Kiểm tra dịch vụ api rồi thử lại.');
      else if (err instanceof ApiError && err.status === 428) setFormError('Hệ thống chưa thiết lập xong — đang chuyển tới trình thiết lập.');
      else setFormError(err instanceof Error ? err.message : 'Đăng nhập không thành công.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit} noValidate aria-labelledby="login-title">
        <div className="login-card__brand">
          <Logo wide />
          <div className="sb-rule" aria-hidden />
        </div>
        <div className="login-card__body">
          <div>
            <h1 className="screen-title" id="login-title">
              Đăng nhập Console
            </h1>
            <p className="screen-desc">Dùng tài khoản đã tạo ở trình thiết lập hoặc được Owner mời.</p>
          </div>
          <TextField
            label="Email"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, email: true }))}
            error={emailError}
          />
          <TextField
            label="Mật khẩu"
            revealable
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, password: true }))}
            error={passwordError}
          />
          <div className="login-card__error" role="alert" aria-live="assertive">
            {formError}
          </div>
          <Button variant="primary" type="submit" block loading={busy} disabled={!canSubmit && !busy} iconRight="ph ph-arrow-right">
            Đăng nhập
          </Button>
        </div>
      </form>
    </div>
  );
}
