import { useMatches } from 'react-router-dom';
import type { DomainId } from '@gen-harness/contracts';

/** Route handles that build the breadcrumb (routes are nested domain › group › screen). */
export interface RouteHandle {
  domain?: DomainId;
  group?: string;
  screen?: string;
  /** Trang ngoài danh mục màn (vd. Tài khoản của tôi) — breadcrumb cố định. */
  page?: { domain: string; title: string; subtitle: string };
}

export const ACCOUNT_CRUMBS = { domain: 'TÀI KHOẢN', title: 'Tài khoản của tôi', subtitle: 'My account' };

export function useActiveScreenKey(): string | null {
  const matches = useMatches();
  for (let i = matches.length - 1; i >= 0; i--) {
    const h = matches[i].handle as RouteHandle | undefined;
    if (h?.screen) return h.screen;
  }
  return null;
}
