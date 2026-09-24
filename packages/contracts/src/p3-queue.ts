/** Hợp đồng API giai đoạn 3 · Hàng đợi & Hành động (docs/api/phase-3-queue.md). */
import type { ApiClient } from './client';

/** Endpoint của cụm — gộp vào `createEndpoints` dưới khoá `queue` (vd `api.queue.list(...)`). */
export function queueEndpoints(r: ApiClient['request']) {
  void r;
  return {};
}
