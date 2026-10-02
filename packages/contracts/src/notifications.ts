/**
 * Hợp đồng Đợt B6 (v0.1.23) — chuông thông báo ở header (`apps/api/gh/notifications.py`, bảng core.notifications).
 * Mỗi thông báo thuộc đúng một người nhận; API chỉ trả của người đang đăng nhập. Sự kiện WS `notification.new`
 * (chỉ gửi tới người nhận) mang đúng một `NotificationItem`.
 */
import type { ApiClient } from './client';

export interface NotificationItem {
  id: string;
  /**
   * Ví dụ `user.role_changed`, `user.password_reset`, `user.reactivated`, `backup.done`, `backup.failed`; v0.1.36 (F-6)
   * thêm sự cố sức khoẻ (khử trùng lặp theo `ops.health_alerts`): `channel.down`, `model.auth_expired`, `update.failed`,
   * `backup.stale`, `worker.silent`, `disk.low`.
   */
  kind: string;
  title: string;
  body: string;
  /** Đường dẫn trong Console để mở khi bấm (vd `/system?tab=storage`); null = không có. */
  link: string | null;
  created_at: string;
  read: boolean;
}

export interface NotificationsPage {
  items: NotificationItem[];
  unread: number;
}

export function notificationsEndpoints(r: ApiClient['request']) {
  return {
    notifications: {
      list: (limit = 20, signal?: AbortSignal) => r<NotificationsPage>('/notifications', { query: { limit }, signal }),
      /** `ids` bỏ trống = đánh dấu TẤT CẢ đã đọc. */
      markRead: (ids?: string[]) =>
        r<{ unread: number }>('/notifications/read', { method: 'POST', body: ids?.length ? { ids } : {} }),
    },
  };
}
