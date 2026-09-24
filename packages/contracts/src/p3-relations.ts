/** Hợp đồng API giai đoạn 3 · Quan hệ & Đối tượng (docs/api/phase-3-relations.md). */
import type { ApiClient } from './client';

/** Endpoint của cụm — gộp vào `createEndpoints` dưới khoá `relations` (vd `api.relations.list(...)`). */
export function relationsEndpoints(r: ApiClient['request']) {
  void r;
  return {};
}
