import type { Me } from '@gen-harness/contracts';
import { useMe } from './queries';

/**
 * Capability check from `Me.permissions` ({perm: all|team|assigned|none}).
 * The backend is the authority; the UI only hides or disables write actions.
 */
export function can(me: Pick<Me, 'permissions'> | undefined | null, perm: string): boolean {
  const scope = me?.permissions?.[perm];
  return !!scope && scope !== 'none';
}

export function useCan(perm: string): boolean {
  const me = useMe();
  return can(me.data, perm);
}

/** Org timezone for time formatting (falls back to Asia/Ho_Chi_Minh). */
export function useOrgTimezone(): string {
  const me = useMe();
  return me.data?.org?.timezone || 'Asia/Ho_Chi_Minh';
}
