import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button } from '@gen-harness/ui';
import { api } from '../lib/api';
import { qk, useMe } from '../lib/queries';
import { queryClient } from '../lib/queryClient';
import { toast } from '../lib/toast';
import { Logo } from '../shell/Logo';
import { PasswordForm } from './PasswordForm';

/**
 * "Đặt mật khẩu mới" (`/change-password`, v0.1.19): mật khẩu hiện tại do hệ thống đặt (`genh reset-password`)
 * → `me.must_change_password`. AppShell chuyển mọi màn Console về đây cho tới khi đổi xong; vẫn đăng xuất được.
 */
export function ForcePasswordPage() {
  const me = useMe();
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    document.title = 'Đặt mật khẩu mới · Gen-Harness';
  }, []);

  if (me.data && !me.data.must_change_password) return <Navigate to="/overview" replace />;

  const logout = async () => {
    setLeaving(true);
    try {
      await api.auth.logout();
    } catch {
      // phiên mất rồi thì cũng về trang đăng nhập
    }
    queryClient.clear();
    navigate('/login', { replace: true });
  };

  return (
    <div className="login">
      <div className="login-card acct-force" role="region" aria-labelledby="force-title">
        <div className="login-card__brand">
          <Logo wide />
          <div className="sb-rule" aria-hidden />
        </div>
        <div className="login-card__body">
          <div>
            <h1 className="screen-title" id="force-title">
              Đặt mật khẩu mới
            </h1>
            <p className="screen-desc">
              {me.data ? `${me.data.addressing?.bot_calls_me || 'Sếp'} đang dùng mật khẩu tạm` : 'Tài khoản đang dùng mật khẩu tạm'} do
              lệnh <code className="mono">genh reset-password</code> tạo. Đặt mật khẩu riêng để tiếp tục vào Console — các thiết bị
              khác sẽ tự đăng xuất.
            </p>
          </div>
          <PasswordForm
            currentLabel="Mật khẩu tạm hiện tại"
            submitLabel="Lưu mật khẩu mới"
            autoFocus
            block
            onDone={async () => {
              const cur = queryClient.getQueryData(qk.me);
              if (cur) queryClient.setQueryData(qk.me, { ...cur, must_change_password: false });
              await queryClient.invalidateQueries({ queryKey: qk.me });
              toast('Đã đặt mật khẩu mới.');
              navigate('/overview', { replace: true });
            }}
            footer={
              <Button variant="ghost" block icon="ph ph-sign-out" loading={leaving} onClick={() => void logout()}>
                Đăng xuất
              </Button>
            }
          />
        </div>
      </div>
    </div>
  );
}
