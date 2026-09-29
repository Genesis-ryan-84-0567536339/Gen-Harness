import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export const qk = {
  me: ['auth', 'me'] as const,
  navigation: ['shell', 'navigation'] as const,
  header: ['shell', 'header'] as const,
  setupState: ['setup', 'state'] as const,
  /** v0.1.23 (B6): chuông thông báo — `notification.new` qua WS chèn thẳng vào đây (lib/realtime.ts). */
  notifications: ['notifications'] as const,
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

/** B6: 20 thông báo gần nhất + số chưa đọc. WS là đường chính; hỏi lại mỗi 2 phút phòng khi socket rớt. */
export const useNotifications = (enabled = true) =>
  useQuery({
    queryKey: qk.notifications,
    queryFn: ({ signal }) => api.notifications.list(20, signal),
    refetchInterval: 120_000,
    enabled,
  });
