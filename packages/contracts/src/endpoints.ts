import type { ApiClient } from './client';
import type {
  AuditPage,
  AuditVerify,
  HeaderStatus,
  Health,
  Me,
  NavDomain,
  Plugin,
  Ready,
  SetupState,
  SetupStep1Body,
  SetupStep2Body,
  SetupStep3Body,
} from './schema';

/** Typed phase-1 endpoints (docs/api/phase-1.md). */
export function createEndpoints(client: ApiClient) {
  const r = client.request;
  return {
    auth: {
      login: (body: { email: string; password: string }) =>
        r<Me>('/auth/login', { method: 'POST', body, skipAuthRedirect: true }),
      logout: () => r<void>('/auth/logout', { method: 'POST', skipAuthRedirect: true }),
      me: (signal?: AbortSignal) => r<Me>('/auth/me', { signal }),
      verifyPin: (pin: string) =>
        r<{ pin_verified_until: string }>('/auth/pin/verify', {
          method: 'POST',
          body: { pin },
          skipPinFlow: true,
          skipAuthRedirect: true,
        }),
      changePin: (current_pin: string, new_pin: string) =>
        r<void>('/auth/pin', { method: 'PUT', body: { current_pin, new_pin } }),
    },
    shell: {
      navigation: (signal?: AbortSignal) => r<NavDomain[]>('/navigation', { signal }),
      header: (signal?: AbortSignal) => r<HeaderStatus>('/header', { signal }),
      health: () => r<Health>('/health'),
      ready: () => r<Ready>('/ready'),
    },
    setup: {
      state: (signal?: AbortSignal) =>
        r<SetupState>('/setup/state', { signal, skipAuthRedirect: true, skipSetupRedirect: true }),
      step1: (body: SetupStep1Body) =>
        r<SetupState>('/setup/steps/1', { method: 'PUT', body, skipAuthRedirect: true, skipSetupRedirect: true }),
      step2: (body: SetupStep2Body) =>
        r<SetupState>('/setup/steps/2', { method: 'PUT', body, skipAuthRedirect: true, skipSetupRedirect: true }),
      step3: (body: SetupStep3Body) =>
        r<SetupState>('/setup/steps/3', { method: 'PUT', body, skipSetupRedirect: true }),
      skip: (n: number) =>
        r<SetupState>(`/setup/steps/${n}/skip`, { method: 'POST', skipSetupRedirect: true }),
    },
    audit: {
      list: (q: { cursor?: string; limit?: number; actor_type?: string; action?: string } = {}) =>
        r<AuditPage>('/audit', { query: q }),
      verify: () => r<AuditVerify>('/audit/verify'),
    },
    plugins: {
      list: () => r<Plugin[]>('/plugins'),
      toggle: (pkg: string, enabled: boolean) =>
        r<Plugin>(`/plugins/${encodeURIComponent(pkg)}/toggle`, { method: 'PATCH', body: { enabled } }),
      remove: (pkg: string) => r<void>(`/plugins/${encodeURIComponent(pkg)}`, { method: 'DELETE' }),
    },
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
