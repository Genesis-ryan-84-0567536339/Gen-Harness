/** Người dùng (v0.1.22, Đợt B1) + Tổ chức (Đợt B2) — hằng số và hàm thuần dùng chung với test. */
import type { InviteRole, ManagedUser } from '@gen-harness/contracts';

export const ORG_KEY = ['system', 'org'] as const;

export const USERS_KEY = ['system', 'users'] as const;

export const INVITE_ROLES: Array<{ value: InviteRole; label: string }> = [
  { value: 'manager', label: 'Manager · quản lý team' },
  { value: 'operator', label: 'Operator · vận hành' },
  { value: 'agent_staff', label: 'Agent nhân viên' },
  { value: 'auditor', label: 'Auditor · kiểm toán' },
];

/** Trạng thái hiển thị của một người dùng. */
export function userStatus(u: Pick<ManagedUser, 'status' | 'must_change_password' | 'last_login_at'>): { label: string; tone: 'ok' | 'warn' | 'neutral' } {
  if (u.status === 'inactive') return { label: 'Đã khoá', tone: 'neutral' };
  if (u.must_change_password) return { label: u.last_login_at ? 'Chờ đổi mật khẩu' : 'Chưa đăng nhập', tone: 'warn' };
  return { label: 'Hoạt động', tone: 'ok' };
}
