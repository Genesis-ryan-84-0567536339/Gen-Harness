/**
 * Hợp đồng v0.1.55 (G5) — Mặt tiền Owner (`apps/api/gh/owner/routes.py`, CHỈ ĐỌC, CHỈ Owner; vai trò khác 403 FORBIDDEN).
 *
 * - `GET /owner/today` → {@link OwnerToday}: Cần Sếp duyệt (≤ 10), 4 số, Bản tin mới nhất, giá trị bộ lọc, gợi ý, tiến độ.
 * - `GET /owner/relations?list=hot|cooling|bridges|matches&limit=20` → {@link OwnerRelations} (limit chặn ≤ 50).
 * - `GET /owner/tasks` → {@link OwnerTasks}: Hộp thư đã lọc, Bàn làm việc, Việc & Nhắc hẹn (đếm + vài dòng + link sâu).
 *
 * Mọi `to` là đường dẫn TRONG Console (link sâu tới luồng sẵn có — Mặt tiền không ghi gì). Số đếm chạm trần 999 hiện "999+".
 * Kiểu gợi ý khai riêng ở đây (không import từ defaults.ts) để hai gói độc lập khi tích hợp.
 */
import type { ApiClient } from './client';

export type OwnerReviewKind = 'draft' | 'proposal' | 'overdue_task';

/** Một việc chờ Sếp duyệt: bản nháp (Bàn làm việc), đề xuất của Gen (mã PIN), việc quá hạn. */
export interface OwnerReviewItem {
  kind: OwnerReviewKind;
  title: string;
  to: string;
  at: string | null;
}

/** 4 số của Hôm nay (+ giá trị cơ hội): khách nóng, quan hệ nguội, cơ hội đang mở, lời hứa quá hạn. */
export interface OwnerKpis {
  hot: number;
  cooling: number;
  open_opps: number;
  open_value_vnd: number;
  overdue_promises: number;
}

export interface OwnerBriefing {
  title: string;
  at: string | null;
  summary_text: string;
  to: string;
}

/** Giá trị của bộ lọc 7 ngày (hợp đồng G4 `value_summary`). */
export interface OwnerFilterValue {
  filtered: number;
  spam_blocked: number;
  calls_saved: number;
  jev_on: boolean;
}

export type OwnerSuggestionKey = 'apply_standard' | 'background_key_missing';

export interface OwnerSuggestion {
  key: OwnerSuggestionKey;
  title: string;
  body: string;
  /** Đường dẫn trong Console, vd `/system?tab=brain#chuan`. */
  to: string;
}

/** Tiến độ "Việc Sếp cần làm" (lấy từ máy chủ, không ghi cứng). */
export interface OwnerProgress {
  required_done: number;
  required_total: number;
}

export interface OwnerToday {
  needs_review: OwnerReviewItem[];
  kpis: OwnerKpis;
  briefing_latest: OwnerBriefing | null;
  filter_value: OwnerFilterValue;
  suggestions: OwnerSuggestion[];
  progress: OwnerProgress;
}

export type OwnerRelationList = 'hot' | 'cooling' | 'bridges' | 'matches';

export interface OwnerRelationRow {
  id: string;
  name: string;
  subtitle: string;
  metric_text: string;
  /** Link Hồ sơ sống (`/profile?id=…`); cặp Cung ↔ Cầu không có người thì `/supply`. */
  to: string;
}

export interface OwnerRelations {
  list: OwnerRelationList;
  items: OwnerRelationRow[];
}

export type OwnerTaskGroupKey = 'inbox' | 'desk' | 'tasks';

export interface OwnerTaskItem {
  title: string;
  at: string | null;
  to: string;
}

export interface OwnerTaskGroup {
  key: OwnerTaskGroupKey;
  title: string;
  count: number;
  to: string;
  items: OwnerTaskItem[];
}

export interface OwnerTasks {
  groups: OwnerTaskGroup[];
}

/** `/owner/*` — gắn vào `endpoints.ts` (`owner: ownerEndpoints(r)`) khi tích hợp. Chỉ có GET. */
export function ownerEndpoints(r: ApiClient['request']) {
  return {
    today: (signal?: AbortSignal) => r<OwnerToday>('/owner/today', { signal }),
    relations: (list: OwnerRelationList, limit = 20, signal?: AbortSignal) =>
      r<OwnerRelations>('/owner/relations', { signal, query: { list, limit } }),
    tasks: (signal?: AbortSignal) => r<OwnerTasks>('/owner/tasks', { signal }),
  };
}
