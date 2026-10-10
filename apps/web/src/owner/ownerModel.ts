/**
 * v0.1.55 (G5) — Mặt tiền Owner: hàm THUẦN định dạng câu chữ + mô hình điều hướng (không React, test được).
 *
 * Màn Hôm nay/Quan hệ dùng chữ đời thường — không có thuật ngữ kỹ thuật (model, token, API). Mọi chuỗi từ máy chủ đi qua
 * `asText` (không bao giờ render object) và mọi link đi qua `safeLink` (chỉ đường dẫn trong Console).

 */
import { fmtInt } from '../lib/format';
import type {
  OwnerFilterValue,
  OwnerKpis,
  OwnerRelationList,
  OwnerReviewKind,
  OwnerTaskGroupKey,
} from '@gen-harness/contracts';

export type {
  OwnerBriefing,
  OwnerFilterValue,
  OwnerKpis,
  OwnerProgress,
  OwnerRelationList,
  OwnerRelationRow,
  OwnerRelations,
  OwnerReviewItem,
  OwnerReviewKind,
  OwnerSuggestion,
  OwnerSuggestionKey,
  OwnerTaskGroup,
  OwnerTaskGroupKey,
  OwnerTaskItem,
  OwnerTasks,
  OwnerToday,
} from '@gen-harness/contracts';

// ── đường dẫn + thanh điều hướng ───────────────────────────────────────────────────────────────────────────────

export const OWNER_HOME = '/owner';
export const OWNER_PATHS = {
  today: '/owner',
  tasks: '/owner/viec',
  relations: '/owner/quan-he',
  gen: '/owner/gen',
  more: '/owner/them',
} as const;
/** "Cài đặt nâng cao" mở màn Tổng quan của Console — KHÔNG link '/' vì '/' của Owner nay về Mặt tiền. */
export const ADVANCED_SETTINGS_PATH = '/overview';
export const FACEBOOK_PATH = '/social';
export const BACK_TO_FRONT_LABEL = 'Về Mặt tiền';
/** Phân tích chưa làm (v0.1.56) — mục thanh trái hiện mờ, không bấm được. */
export const SOON_LABEL = 'sắp có';
/** Máy chủ chặn số đếm ở 999 (đếm chạm trần ⇒ hiện "999+"). */
export const COUNT_CAP = 999;

export interface OwnerNavItem {
  key: 'today' | 'tasks' | 'relations' | 'gen' | 'analytics' | 'more';
  label: string;
  icon: string;
  to: string;
  /** Chưa có (disabled, nhãn "sắp có"). */
  soon?: boolean;
}

/** Thanh trái máy tính: 6 mục. Thanh dưới điện thoại: 5 mục (bỏ mục "sắp có"). */
export const OWNER_NAV: readonly OwnerNavItem[] = [
  { key: 'today', label: 'Hôm nay', icon: 'ph ph-sun', to: OWNER_PATHS.today },
  { key: 'tasks', label: 'Việc', icon: 'ph ph-check-square', to: OWNER_PATHS.tasks },
  { key: 'relations', label: 'Quan hệ', icon: 'ph ph-users-three', to: OWNER_PATHS.relations },
  { key: 'gen', label: 'Hỏi Gen', icon: 'ph ph-sparkle', to: OWNER_PATHS.gen },
  { key: 'analytics', label: 'Phân tích', icon: 'ph ph-chart-line-up', to: '/owner/phan-tich', soon: true },
  { key: 'more', label: 'Thêm', icon: 'ph ph-dots-three', to: OWNER_PATHS.more },
];

export const OWNER_TABBAR: readonly OwnerNavItem[] = OWNER_NAV.filter((i) => !i.soon);

/** Mục đang sáng theo đường dẫn (`/owner` chỉ khớp đúng chính nó). */
export function activeNavKey(pathname: string): OwnerNavItem['key'] {
  const p = pathname.replace(/\/+$/, '') || '/';
  const hit = OWNER_NAV.find((i) => !i.soon && i.to !== OWNER_PATHS.today && (p === i.to || p.startsWith(`${i.to}/`)));
  return hit?.key ?? 'today';
}

export function ownerTitle(pathname: string): string {
  const key = activeNavKey(pathname);
  return OWNER_NAV.find((i) => i.key === key)?.label ?? 'Hôm nay';
}

// ── an toàn chuỗi/link ─────────────────────────────────────────────────────────────────────────────────────────

/** Chuỗi an toàn cho JSX: máy chủ cũ/lạ trả object thì bỏ (không bao giờ render object vào JSX). */
export function asText(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

/** Chỉ nhận đường dẫn TRONG Console (bắt đầu bằng một dấu '/'); lạ thì dùng `fallback`. */
export function safeLink(to: unknown, fallback: string = OWNER_HOME): string {
  const s = asText(to).trim();
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || /\s/.test(s) || [...s].some((c) => c.charCodeAt(0) < 32)) return fallback;
  return s;
}

// ── câu chữ ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Số đếm của máy chủ: chạm trần 999 ⇒ "999+"; không phải số ⇒ "—". */
export function countText(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n >= COUNT_CAP ? `${fmtInt(COUNT_CAP)}+` : fmtInt(n);
}

/** 3_500_000 → "3,5 triệu ₫"; 1_200_000_000 → "1,2 tỷ ₫"; 850_000 → "850.000 ₫". */
export function moneyText(vnd: unknown): string {
  if (typeof vnd !== 'number' || !Number.isFinite(vnd)) return '—';
  const abs = Math.abs(vnd);
  const dec = (x: number) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(x);
  if (abs >= 1_000_000_000) return `${dec(vnd / 1_000_000_000)} tỷ ₫`;
  if (abs >= 1_000_000) return `${dec(vnd / 1_000_000)} triệu ₫`;
  return `${fmtInt(vnd)} ₫`;
}

/** "Tuần này Gen lọc giúp Sếp N tin rác/trùng, bớt M lượt gọi AI." — null khi tuần này chưa lọc gì (không hiện thẻ). */
export function filterValueText(fv: Pick<OwnerFilterValue, 'filtered' | 'calls_saved'> | null | undefined): string | null {
  const n = typeof fv?.filtered === 'number' && fv.filtered > 0 ? fv.filtered : 0;
  const m = typeof fv?.calls_saved === 'number' && fv.calls_saved > 0 ? fv.calls_saved : 0;
  if (n === 0 && m === 0) return null;
  return `Tuần này Gen lọc giúp Sếp ${fmtInt(n)} tin rác/trùng, bớt ${fmtInt(m)} lượt gọi AI.`;
}

/** "Việc Sếp cần làm: 0/1 việc bắt buộc đã xong" (tổng lấy từ máy chủ). */
export function progressText(done: unknown, total: unknown): string {
  const d = typeof done === 'number' ? done : 0;
  const t = typeof total === 'number' ? total : 0;
  if (t <= 0) return 'Việc Sếp cần làm';
  return d >= t ? `Việc Sếp cần làm: đã xong cả ${fmtInt(t)} việc bắt buộc` : `Việc Sếp cần làm: ${fmtInt(d)}/${fmtInt(t)} việc bắt buộc đã xong`;
}

export const REVIEW_LABEL: Record<OwnerReviewKind, string> = {
  draft: 'Bản nháp',
  proposal: 'Gen đề xuất',
  overdue_task: 'Việc quá hạn',
};
export const REVIEW_ICON: Record<OwnerReviewKind, string> = {
  draft: 'ph ph-envelope',
  proposal: 'ph ph-sparkle',
  overdue_task: 'ph ph-clock-countdown',
};
export const REVIEW_TONE: Record<OwnerReviewKind, 'accent' | 'warn' | 'bad'> = {
  draft: 'accent',
  proposal: 'warn',
  overdue_task: 'bad',
};

export function reviewLabel(kind: unknown): string {
  return REVIEW_LABEL[kind as OwnerReviewKind] ?? 'Cần xem';
}

export interface KpiCard {
  key: 'hot' | 'cooling' | 'open_opps' | 'overdue_promises';
  label: string;
  value: string;
  sub: string | null;
  to: string;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
  icon: string;
}

/** 4 số của Hôm nay, mỗi số mở đúng danh sách của nó. */
export function kpiCards(k: OwnerKpis): KpiCard[] {
  return [
    { key: 'hot', label: 'Khách nóng', value: countText(k.hot), sub: 'đang quan tâm mạnh', to: `${OWNER_PATHS.relations}?list=hot`,
      tone: k.hot > 0 ? 'ok' : 'neutral', icon: 'ph ph-fire' },
    { key: 'cooling', label: 'Quan hệ nguội', value: countText(k.cooling), sub: 'lâu chưa liên lạc', to: `${OWNER_PATHS.relations}?list=cooling`,
      tone: k.cooling > 0 ? 'warn' : 'neutral', icon: 'ph ph-snowflake' },
    { key: 'open_opps', label: 'Cơ hội đang mở', value: countText(k.open_opps), sub: k.open_opps > 0 ? moneyText(k.open_value_vnd) : null,
      to: '/opportunity', tone: 'neutral', icon: 'ph ph-handshake' },
    { key: 'overdue_promises', label: 'Lời hứa quá hạn', value: countText(k.overdue_promises), sub: 'chưa giữ', to: '/tasks?ptab=overdue',
      tone: k.overdue_promises > 0 ? 'bad' : 'neutral', icon: 'ph ph-warning-circle' },
  ];
}

export interface RelationTab {
  list: OwnerRelationList;
  label: string;
  hint: string;
  emptyTitle: string;
  emptyHint: string;
}

export const RELATION_TABS: readonly RelationTab[] = [
  { list: 'hot', label: 'Khách nóng', hint: 'Những người đang quan tâm mạnh — nên hồi âm sớm.',
    emptyTitle: 'Chưa có khách nóng', emptyHint: 'Khi có người nhắn nhiều và nhắn thường xuyên, em sẽ xếp họ lên đây.' },
  { list: 'cooling', label: 'Quan hệ nguội', hint: 'Hai bên từng trao đổi nhiều nhưng đã hơn 30 ngày chưa liên lạc.',
    emptyTitle: 'Chưa có quan hệ nào nguội', emptyHint: 'Em sẽ báo khi một mối quan hệ đang tốt bỗng im quá lâu.' },
  { list: 'bridges', label: 'Cầu nối', hint: 'Người có mặt ở nhiều nhóm, nối các nhóm với nhau.',
    emptyTitle: 'Chưa thấy người cầu nối', emptyHint: 'Cần có người ở từ hai nhóm chat trở lên em mới nhận ra được.' },
  { list: 'matches', label: 'Cung ↔ Cầu', hint: 'Người đang cần mua gặp người đang có hàng.',
    emptyTitle: 'Chưa có cặp nào hợp nhau', emptyHint: 'Khi có người hỏi mua và có người chào bán cùng mặt hàng, em sẽ ghép lại.' },
];

/** Câu gợi ý ở màn Hỏi Gen (máy tính, bên trái): bấm ⇒ chỉ ĐIỀN SẴN ô nhập của Gen, không gửi. */
export const ASK_GEN_PROMPTS = [
  'Hôm nay có gì cần tôi xử lý?',
  'Khách nào hỏi giá hôm nay?',
  'Nhắc tôi gọi lại khách lúc 3 giờ chiều',
  'Soạn nháp trả lời khách vừa hỏi giá',
] as const;

export function isRelationList(v: unknown): v is OwnerRelationList {
  return v === 'hot' || v === 'cooling' || v === 'bridges' || v === 'matches';
}

export function relationTab(list: OwnerRelationList): RelationTab {
  return RELATION_TABS.find((t) => t.list === list) ?? RELATION_TABS[0];
}

export const TASK_GROUP_ICON: Record<OwnerTaskGroupKey, string> = {
  inbox: 'ph ph-tray',
  desk: 'ph ph-note-pencil',
  tasks: 'ph ph-check-square',
};
export const TASK_GROUP_EMPTY: Record<OwnerTaskGroupKey, string> = {
  inbox: 'Hộp thư chưa có tin quan trọng mới.',
  desk: 'Không có bản nháp nào chờ duyệt.',
  tasks: 'Không có việc nào đang mở.',
};

/** Viên chữ cái đầu cho dòng danh sách ("Nguyễn Văn An" → "NA"). */
export function avatarText(name: unknown): string {
  const parts = asText(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  if (parts.length === 1) return [...parts[0]].slice(0, 2).join('').toLocaleUpperCase('vi');
  return ((parts[0][0] ?? '') + (parts.at(-1)?.[0] ?? '')).toLocaleUpperCase('vi');
}

// ── trạng thái kết nối (màn Thêm) ──────────────────────────────────────────────────────────────────────────────

/** Dòng "Việc Sếp cần làm" nào là một DỊCH VỤ kết nối (hiện ở màn Thêm). */
export const CONNECTION_ROW_KEYS = ['ai', 'hub', 'facebook', 'agy', 'claude', 'telegram', 'remote', 'jev'] as const;

export interface ConnectionLine {
  key: string;
  title: string;
  state: 'ok' | 'todo' | 'optional';
  text: string;
  to: string;
}

interface BossRowLike {
  key: unknown;
  title: unknown;
  optional?: unknown;
  done?: unknown;
}

/**
 * Một dòng cho mỗi dịch vụ: "Đã kết nối" / "Chưa kết nối" (+ "tuỳ chọn" cho dịch vụ không bắt buộc). Facebook → /social.
 * Dòng `ai` (nguồn AI chạy được — dòng bắt buộc duy nhất) đứng đầu và nói "Đã chạy được" / "Chưa có — cần làm".
 */
export function connectionLines(rows: readonly BossRowLike[] | undefined): ConnectionLine[] {
  const out: ConnectionLine[] = [];
  for (const key of CONNECTION_ROW_KEYS) {
    const r = rows?.find((x) => x.key === key);
    if (!r) continue;
    const done = r.done === true;
    const optional = r.optional === true;
    out.push({
      key,
      title: asText(r.title) || key,
      state: done ? 'ok' : optional ? 'optional' : 'todo',
      text: key === 'ai' ? (done ? 'Đã chạy được' : 'Chưa có — cần làm') : done ? 'Đã kết nối' : optional ? 'Chưa bật (tuỳ chọn)' : 'Chưa kết nối',
      to: key === 'facebook' ? FACEBOOK_PATH : '/guide/viec-sep',
    });
  }
  return out;
}
