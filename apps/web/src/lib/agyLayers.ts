/**
 * Gói G (Sếp chốt 16/10/2026) — Antigravity CLI (agy) PHÂN LỚP, nói đúng với người dùng:
 * - lớp core (Gen của Sếp, sàng lọc tin, Bản tin, agent nội bộ) dùng được agy;
 * - lớp ngoại giao (soạn lại / dịch nháp tin gửi khách, agent gắn kênh / nhóm / người) CHƯA dùng agy — chờ hộp riêng (bản sau);
 * - Gen của nhân viên không dùng agy.
 * Câu lý do của từng dòng do máy chủ trả (`agy_blocked_reason`, một hàm quyết định `gh.providers.agy_policy.decide`);
 * file này chỉ giữ câu phạm vi chung cho thẻ Antigravity CLI và hàm nhận biết model agy.
 */

export const AGY_LAYERS_TEXT =
  'Dùng được cho: Gen của Sếp, sàng lọc tin, Bản tin và agent nội bộ. Chưa dùng cho việc trả lời người ngoài (soạn lại / dịch nháp, agent gắn kênh hoặc nhóm chat) và Gen của nhân viên — chờ hộp riêng (bản sau). Lưu ý: Antigravity CLI chạy cùng máy chủ với khoá hệ thống.';

export const AGY_BACKGROUND_NOTE =
  'Antigravity CLI chạy được sàng lọc tin và Bản tin, không cần Sếp cho phép. Agent trực kênh trả lời người ngoài chưa dùng Antigravity (chờ hộp riêng, bản sau) — cần khoá API.';

export const AGY_KIND = 'antigravity_cli';

/** Model này thuộc nguồn Antigravity CLI? (`kind` do máy chủ gửi trong `models` của /agents/bindings; máy chủ cũ: thiếu ⇒ false). */
export function isAgyModel(m: { kind?: string | null }): boolean {
  return m.kind === AGY_KIND;
}

/** Lý do (chuỗi) Antigravity không dùng được cho dòng này, hoặc null — không bao giờ object. */
export function agyBlockedReason(slot: { agy_blocked_reason?: string | null }): string | null {
  const r = typeof slot.agy_blocked_reason === 'string' ? slot.agy_blocked_reason.trim() : '';
  return r || null;
}
