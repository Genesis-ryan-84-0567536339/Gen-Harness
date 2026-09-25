import { ApiError, createApiClient, createEndpoints } from '@gen-harness/contracts';
import { currentPath, navigateTo } from './navigation';
import { usePinStore } from './pinStore';
import { queryClient } from './queryClient';

const PUBLIC_PREFIXES = ['/login', '/setup'];

export const apiClient = createApiClient({
  baseUrl: '/api/v1',
  onUnauthenticated: () => {
    const here = currentPath();
    if (PUBLIC_PREFIXES.some((p) => window.location.pathname.startsWith(p))) return;
    queryClient.clear();
    navigateTo(`/login?next=${encodeURIComponent(here)}`, { replace: true });
  },
  onSetupRequired: () => {
    if (window.location.pathname.startsWith('/setup')) return;
    navigateTo('/setup', { replace: true });
  },
  requestPin: () => usePinStore.getState().request(),
});

export const api = createEndpoints(apiClient);

export { ApiError };
