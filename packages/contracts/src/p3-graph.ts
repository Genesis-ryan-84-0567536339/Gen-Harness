/** Hợp đồng API giai đoạn 3 · Bản đồ quan hệ (docs/api/phase-3-graph.md). */
import type { ApiClient } from './client';

/** Endpoint của cụm — gộp vào `createEndpoints` dưới khoá `graph` (vd `api.graph.list(...)`). */
export function graphEndpoints(r: ApiClient['request']) {
  void r;
  return {};
}
