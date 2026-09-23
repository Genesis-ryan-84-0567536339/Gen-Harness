import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export const qk = {
  me: ['auth', 'me'] as const,
  navigation: ['shell', 'navigation'] as const,
  header: ['shell', 'header'] as const,
  setupState: ['setup', 'state'] as const,
};

export const useMe = () => useQuery({ queryKey: qk.me, queryFn: ({ signal }) => api.auth.me(signal) });
export const useNavigation = () =>
  useQuery({ queryKey: qk.navigation, queryFn: ({ signal }) => api.shell.navigation(signal) });
export const useHeaderStatus = () =>
  useQuery({
    queryKey: qk.header,
    queryFn: ({ signal }) => api.shell.header(signal),
    refetchInterval: 60_000,
  });
