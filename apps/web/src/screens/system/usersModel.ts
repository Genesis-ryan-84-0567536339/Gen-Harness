/** Người dùng (v0.1.22, Đợt B1) + Tổ chức (Đợt B2) — hằng số và hàm thuần dùng chung với test. */
import type { InviteRole, ManagedUser, TempPasswordResult } from '@gen-harness/contracts';

export const ORG_KEY = ['system', 'org'] as const;

export const USERS_KEY = ['system', 'users'] as const;

export const INVITE_ROLES: Array<{ value: InviteRole; label: string }> = [
  { value: 'manager', label: 'Quản lý — thấy team mình' },
  { value: 'operator', label: 'Vận hành — xử lý hàng đợi việc' },
  { value: 'agent_staff', label: 'Nhân viên phụ trách — chỉ khách được phân' },
  { value: 'auditor', label: 'Kiểm soát — chỉ xem' },
];

/** Trạng thái hiển thị của một người dùng. */
export function userStatus(u: Pick<ManagedUser, 'status' | 'must_change_password' | 'last_login_at'>): { label: string; tone: 'ok' | 'warn' | 'neutral' } {
  if (u.status === 'inactive') return { label: 'Đã khoá', tone: 'neutral' };
  if (u.must_change_password) return { label: u.last_login_at ? 'Chờ đổi mật khẩu' : 'Chưa đăng nhập', tone: 'warn' };
  return { label: 'Hoạt động', tone: 'ok' };
}

/** v0.1.28 (UX V4): một lời nhắn gửi một lần là đủ — địa chỉ đăng nhập + email + mật khẩu tạm. */
export function inviteMessage(r: Pick<TempPasswordResult, 'user' | 'temp_password'>, origin: string): string {
  return [
    `Chào ${r.user.display_name}, mời bạn vào Gen-Harness:`,
    `Địa chỉ: ${origin}/login`,
    `Email: ${r.user.email}`,
    `Mật khẩu tạm: ${r.temp_password}`,
    'Lần đăng nhập đầu hệ thống sẽ yêu cầu bạn đặt mật khẩu mới.',
  ].join('\n');
}
