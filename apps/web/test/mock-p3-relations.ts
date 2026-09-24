/**
 * Mock API giai đoạn 3 · Quan hệ & Đối tượng. `handle` trả true khi đã trả lời request.
 * Dữ liệu mẫu lấy từ docs/design/seed-data.json để màn hiện đúng như thiết kế.
 */
import type { P2Ctx } from './mock-phase2';

export interface P3Options {
  fresh: boolean;
  emit: (type: string, data: unknown) => void;
}

export function createMock(_opts: P3Options) {
  function handle(_ctx: P2Ctx): boolean {
    return false;
  }
  return { handle, hooks: {} as Record<string, (...args: never[]) => unknown>, dispose: () => {} };
}
