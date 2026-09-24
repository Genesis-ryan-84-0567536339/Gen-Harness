/** Hợp đồng API giai đoạn 3 · Con người & Chất lượng (docs/api/phase-3-people.md). */
import type { ApiClient } from './client';

/** Endpoint của cụm — gộp vào `createEndpoints` dưới khoá `people` (vd `api.people.list(...)`). */
export function peopleEndpoints(r: ApiClient['request']) {
  void r;
  return {};
}
