import { useState } from 'react';
import type { TempPasswordResult } from '@gen-harness/contracts';
import { Button, Dialog, Icon } from '@gen-harness/ui';
import { errorDetail } from '../../lib/errorText';
import { toast } from '../../lib/toast';
import { useAccess } from './queries';
import { inviteMessage } from './usersModel';

/**
 * Hộp "mật khẩu tạm" sau khi mời / đặt lại mật khẩu (tách từ UsersTab, v0.1.46 F-21). Địa chỉ đăng nhập trong lời nhắn
 * là `login_url` của `GET /system/access` (GH_PUBLIC_URL) — KHÔNG phải địa chỉ trình duyệt của Owner đang mở: Owner ngồi
 * ở máy chủ mở bằng localhost thì nhân viên ở máy khác không vào được, nên báo đỏ ngay trong hộp.
 */
export function TempPasswordDialog({ title, result, onClose }: { title: string; result: TempPasswordResult; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const access = useAccess();
  const loginUrl = access.data?.login_url ?? null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteMessage(result, loginUrl));
      setCopied(true);
    } catch {
      toast('Không chép được — hãy bôi đen và chép tay.', 'warn');
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={false}
      width={460}
      title={title}
      kicker="Mật khẩu tạm chỉ hiện MỘT lần"
      actions={
        <>
          <Button variant="secondary" icon={copied ? 'ph ph-check' : 'ph ph-copy'} disabled={access.isPending} onClick={() => void copy()}>
            {copied ? 'Đã chép' : 'Chép lời nhắn gửi nhân viên'}
          </Button>
          <Button variant="primary" onClick={onClose}>
            Đã gửi, đóng
          </Button>
        </>
      }
    >
      {access.isError ? (
        <div className="inline-error" style={{ marginBottom: 10, fontSize: 12 }} role="alert" data-testid="invite-local-warning">
          Chưa đọc được địa chỉ đăng nhập — gửi kèm địa chỉ Console mà nhân viên mở được (lời nhắn đã chép không có dòng địa chỉ).
          {errorDetail(access.error) ? (
            <details className="tech-detail">
              <summary>Chi tiết kỹ thuật</summary>
              <code>{errorDetail(access.error)}</code>
            </details>
          ) : null}
        </div>
      ) : access.data?.public_url_local ? (
        <div className="inline-error" style={{ marginBottom: 10, fontSize: 12 }} role="alert" data-testid="invite-local-warning">
          Địa chỉ này chỉ mở được trên chính máy chủ — nhân viên ở máy khác hoặc điện thoại sẽ KHÔNG vào được. Trên máy chủ chạy <code className="mono">genh remote tailscale</code> (khuyên dùng) hoặc{' '}
          <code className="mono">genh remote --lan</code>, rồi bấm Chép lời nhắn lại.
        </div>
      ) : null}
      <div className="invite-result-row" data-gen-target="system.users.temp_password">
        <Icon name="ph ph-user-plus" size={15} color="var(--color-accent-300)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="invite-result-row__name">
            {result.user.display_name} · {result.user.role.name}
          </div>
          <div className="invite-result-row__email">{result.user.email}</div>
        </div>
        <span className="mono invite-result-row__pw" aria-label="Mật khẩu tạm">
          {result.temp_password}
        </span>
      </div>
      <p className="muted-note">
        Gửi cho người này qua kênh riêng (Zalo, email cá nhân…) — lời nhắn đã chép gồm {loginUrl ? <>địa chỉ đăng nhập {loginUrl}, </> : 'địa chỉ đăng nhập (nếu đọc được), '}email và mật khẩu tạm. Đăng nhập lần đầu
        sẽ bắt đặt mật khẩu mới. Hộp này chỉ đóng bằng nút "Đã gửi, đóng" — đóng rồi là không xem lại được, quên thì bấm Đặt lại mật khẩu.
      </p>
    </Dialog>
  );
}
