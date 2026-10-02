import { useMatches } from 'react-router-dom';
import type { DomainId } from '@gen-harness/contracts';

/** Route handles that build the breadcrumb (routes are nested domain › group › screen). */
export interface RouteHandle {
  domain?: DomainId;
  group?: string;
  screen?: string;
  /** Trang ngoài danh mục màn (vd. Tài khoản của tôi) — breadcrumb cố định. */
  page?: { domain: string; title: string; subtitle: string };
  /**
   * v0.1.42: trang ngoài danh mục màn tô sáng mục nào trên thanh bên (social → 'connections'; guide, account, help →
   * 'system').
   */
  navKey?: string;
}

export const ACCOUNT_CRUMBS = { domain: 'TÀI KHOẢN', title: 'Tài khoản của tôi', subtitle: 'My account' };
export const HELP_CRUMBS = { domain: 'TRỢ GIÚP', title: 'Trợ giúp', subtitle: 'Help & about' };
export const SOCIAL_CRUMBS = { domain: 'KẾT NỐI', title: 'Tài khoản mạng xã hội', subtitle: 'Social accounts' };
/** v0.1.42 (F-66): Hướng dẫn thiết lập có breadcrumb riêng (trước đây trống). */
export const GUIDE_CRUMBS = { domain: 'CÀI ĐẶT', title: 'Hướng dẫn thiết lập', subtitle: '' };
export const BOSS_CHECKS_CRUMBS = { domain: 'CÀI ĐẶT', title: 'Việc Sếp cần làm', subtitle: '' };

export function useActiveScreenKey(): string | null {
  const matches = useMatches();
  for (let i = matches.length - 1; i >= 0; i--) {
    const h = matches[i].handle as RouteHandle | undefined;
    if (h?.screen) return h.screen;
  }
  return null;
}

/** v0.1.42: khoá mục thanh bên cần tô sáng — màn đang mở, hoặc `navKey` của trang ngoài danh mục. */
export function useActiveNavKey(): string | null {
  const matches = useMatches();
  for (let i = matches.length - 1; i >= 0; i--) {
    const h = matches[i].handle as RouteHandle | undefined;
    if (h?.screen) return h.screen;
    if (h?.navKey) return h.navKey;
  }
  return null;
}
