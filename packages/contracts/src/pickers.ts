/**
 * Hợp đồng v0.1.35 (F-1): ô chọn người / trợ lý THẬT cho các thao tác giao/gán (`apps/api/gh/biz/core/pickers.py`).
 * - `GET /pickers/users` — người dùng đang hoạt động cùng tổ chức (chỉ id + tên, không email/vai trò);
 *   cần một trong queue.act / opportunity.write / profile.read. `me` = người đang đăng nhập (web hiện là "Tôi").
 * - `GET /pickers/agents` — trợ lý (agent) đang bật; cần profile.write.
 */
import type { ApiClient } from './client';

export interface PickerUser {
  id: string;
  name: string;
  me: boolean;
}

export interface PickerAgent {
  id: string;
  name: string;
}

export interface PickerList<T> {
  items: T[];
}

export function pickersEndpoints(r: ApiClient['request']) {
  return {
    pickers: {
      users: (signal?: AbortSignal) => r<PickerList<PickerUser>>('/pickers/users', { signal }),
      agents: (signal?: AbortSignal) => r<PickerList<PickerAgent>>('/pickers/agents', { signal }),
    },
  };
}
