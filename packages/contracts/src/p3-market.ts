/** Hợp đồng API giai đoạn 3 · Cơ hội & Thị trường (docs/api/phase-3-market.md). */
import type { ApiClient } from './client';

/** Endpoint của cụm — gộp vào `createEndpoints` dưới khoá `market` (vd `api.market.list(...)`). */
export function marketEndpoints(r: ApiClient['request']) {
  void r;
  return {};
}
