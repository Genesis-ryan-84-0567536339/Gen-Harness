/**
 * v0.1.50 (F-81, QD-18) — hàm thuần cho thẻ đề xuất GHI VÀO KHO RYAN (`kho_create` / `kho_update`) và thẻ GHI NHỚ
 * (`memory_note`): nhãn, câu cảnh báo cố định, bảng trường (đúng `fields.record`), form Sửa theo bảng, câu lỗi theo mã.
 * Không chứa bí mật; mọi giá trị từ máy chủ được ép về chuỗi trước khi hiện (không bao giờ render object).
 */
import { ApiError, KHO_DATE_FIELDS, KHO_FIELDS, KHO_REQUIRED, type GenProposal, type KhoBang } from '@gen-harness/contracts';

export type KhoProposal = Extract<GenProposal, { type: 'kho_create' | 'kho_update' }>;
export type MemoryProposal = Extract<GenProposal, { type: 'memory_note' }>;

export const isKhoWrite = (p: GenProposal): p is KhoProposal => p.type === 'kho_create' || p.type === 'kho_update';
export const isMemoryNote = (p: GenProposal): p is MemoryProposal => p.type === 'memory_note';

/** Câu cảnh báo cố định trên thẻ "Ghi vào Kho Ryan" (còn chờ xác nhận). */
export const KHO_WRITE_WARNING = 'Ghi thẳng vào Kho Ryan qua Gen-hub khi Sếp bấm Xác nhận và nhập mã PIN — không tự hoàn tác.';
export const KHO_MISSING_TEXT = 'Gen-hub chưa cấp quyền ghi Kho';
export const KHO_MISSING_HINT = 'Vào Gen-hub tick quyền kho_create, kho_update cho token của Gen-Harness rồi bấm Kiểm tra ở Kết nối › Gen-hub.';
/** Đích của nút "Mở thẻ Gen-hub" / "Mở Kết nối › Gen-hub" — thẻ Gen-hub ở Kết nối. */
export const HUB_CARD_PATH = '/connections#genhub';
/** "Xem ở Cài đặt" — thẻ Gen nhớ ở Cài đặt › Bộ não AI (cuộn tới thẻ). */
export const MEMORY_CARD_PATH = '/system?tab=brain#gen-memory';

/** Trường chữ dài (ô nhiều dòng khi Sửa). */
const LONG_FIELDS: ReadonlySet<string> = new Set(['Đã chốt', 'Đang bàn', 'Việc tiếp', 'Cảnh báo']);

export type KhoFieldKind = 'text' | 'long' | 'date' | 'status' | 'priority';

export function khoFieldKind(bang: KhoBang, field: string): KhoFieldKind {
  if (KHO_DATE_FIELDS[bang].includes(field)) return 'date';
  if (bang === 'Việc' && field === 'Trạng thái') return 'status';
  if (bang === 'Việc' && field === 'Ưu tiên') return 'priority';
  return LONG_FIELDS.has(field) ? 'long' : 'text';
}

/** Giá trị máy chủ → chuỗi hiện được (chuỗi / số / boolean; còn lại bỏ trống). */
export function valueText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** Bảng của đề xuất: tạo ⇒ `fields.bang`; sửa ⇒ nhãn `bang` hoặc tiền tố của mã ('PHIEN-12' ⇒ Phiên). Lạ ⇒ null. */
export function khoBangOf(p: KhoProposal): KhoBang | null {
  const direct = p.type === 'kho_create' ? p.fields.bang : (p.labels.bang as string | undefined);
  if (direct === 'Phiên' || direct === 'Việc') return direct;
  if (p.type === 'kho_update') {
    const ma = valueText(p.fields.ma).toUpperCase();
    if (ma.startsWith('PHIEN-')) return 'Phiên';
    if (ma.startsWith('VIEC-')) return 'Việc';
  }
  return null;
}

/** Mã / mô tả bản ghi của đề xuất: sửa ⇒ nhãn `target` hoặc `fields.ma`; tạo ⇒ nhãn `target` hoặc "Bản ghi mới". */
export function khoTargetText(p: KhoProposal): string {
  const label = valueText(p.labels.target).trim();
  if (label) return label;
  return p.type === 'kho_update' ? valueText(p.fields.ma) || '—' : 'Bản ghi mới';
}

export interface KhoRow {
  field: string;
  /** Giá trị hiện tại (chỉ khi sửa; trống ⇒ '—'). */
  cur: string | null;
  next: string;
}

/**
 * Các hàng của bảng "Trường | Hiện tại | Sẽ ghi": ĐÚNG các khoá của `fields.record` (không thêm, không bớt — Sếp thấy chính xác
 * cái sẽ ghi), theo thứ tự `KHO_FIELDS`; khoá lạ (máy chủ mới hơn web) đứng cuối theo thứ tự gốc.
 */
export function khoRows(p: KhoProposal): KhoRow[] {
  const record: Record<string, unknown> = p.fields.record && typeof p.fields.record === 'object' ? p.fields.record : {};
  const bang = khoBangOf(p);
  const known = bang ? KHO_FIELDS[bang] : [];
  const keys = Object.keys(record);
  const ordered = [...known.filter((f) => keys.includes(f)), ...keys.filter((k) => !known.includes(k))];
  return ordered.map((field) => ({
    field,
    cur: p.type === 'kho_update' ? valueText(p.labels[`cur:${field}`]).trim() || '—' : null,
    next: valueText(record[field]),
  }));
}

/** Nháp form Sửa: mọi trường được phép của bảng, điền sẵn giá trị đang đề xuất (thiếu ⇒ rỗng). Bảng lạ ⇒ rỗng. */
export function khoInitialDraft(p: KhoProposal): Record<string, string> {
  const bang = khoBangOf(p);
  const record: Record<string, unknown> = p.fields.record && typeof p.fields.record === 'object' ? p.fields.record : {};
  const out: Record<string, string> = {};
  if (!bang) return out;
  for (const f of KHO_FIELDS[bang]) out[f] = valueText(record[f]);
  return out;
}

/** Nháp → `record` gửi lên: chỉ trường được phép của bảng và KHÔNG rỗng (xoá trắng một ô = bỏ trường đó khỏi bản ghi sẽ ghi). */
export function khoDraftRecord(bang: KhoBang, d: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of KHO_FIELDS[bang]) {
    const v = (d[f] ?? '').trim();
    if (v) out[f] = v;
  }
  return out;
}

export function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && valueText(a[k]) === valueText(b[k]));
}

/** Form Sửa hợp lệ: tạo ⇒ có trường bắt buộc (Chủ đề / Tiêu đề); sửa ⇒ còn ít nhất một trường. Link phải là https. */
export function khoDraftValid(p: KhoProposal, d: Record<string, string>): boolean {
  const bang = khoBangOf(p);
  if (!bang) return false;
  const rec = khoDraftRecord(bang, d);
  if (p.type === 'kho_create' && !rec[KHO_REQUIRED[bang]]) return false;
  if (Object.keys(rec).length === 0) return false;
  const link = rec['Link Issue/PR'];
  return !link || /^https:\/\/\S+$/.test(link);
}

/** Lỗi của ô Link khi Sửa (chuỗi) hoặc null. */
export function khoLinkError(d: Record<string, string>): string | null {
  const link = (d['Link Issue/PR'] ?? '').trim();
  return link && !/^https:\/\/\S+$/.test(link) ? 'Link phải bắt đầu bằng https://' : null;
}

/** Quyền ghi Kho của token theo nhãn lúc đề xuất. */
export const writeScopeMissing = (p: KhoProposal): boolean => p.labels.write_scope === 'missing';

// ── Câu lỗi theo mã (xác nhận Ghi nhớ / Ghi vào Kho) ─────────────────────────────────────────────────────────

export type ProposalErrorAction = 'open_hub' | 'open_memory' | null;
export interface ProposalErrorView {
  text: string;
  /** Nút kèm câu lỗi: mở Kết nối › Gen-hub / mở Cài đặt › Gen nhớ. */
  action: ProposalErrorAction;
}

const ERROR_VIEW: Record<string, ProposalErrorView> = {
  HUB_WRITE_MISSING: {
    text: `${KHO_MISSING_TEXT} — ${KHO_MISSING_HINT} Chưa ghi gì vào Kho.`,
    action: 'open_hub',
  },
  HUB_WRITE_UNCERTAIN: {
    text: 'Chưa chắc đã ghi — Sếp mở Kho kiểm trước khi bấm lại.',
    action: null,
  },
  HUB_WRITE_PERMIT: {
    text: 'Giấy phép ghi không hợp lệ hoặc đã quá 5 phút — chưa ghi gì vào Kho. Hỏi Gen đề xuất lại để ghi lần nữa.',
    action: null,
  },
  HUB_TOOL_NOT_ALLOWED: {
    text: 'Thao tác ghi này không nằm trong phạm vi Gen được phép — chưa ghi gì vào Kho.',
    action: null,
  },
  HUB_WRITE_REJECTED: {
    text: 'Gen-hub từ chối bản ghi này (có trường chưa hợp lệ) — chưa ghi gì. Bấm Sửa để chỉnh các trường rồi Xác nhận lại.',
    action: null,
  },
  HUB_BREAKER_OPEN: {
    text: 'Gen-hub tạm không trả lời — Gen tự thử lại sau 1 phút. Chưa ghi gì, Sếp bấm Xác nhận lại sau.',
    action: null,
  },
  HUB_LINK_OFF: {
    text: 'Gen-hub đang tắt — vào Kết nối › Gen-hub bấm Kiểm tra để bật lại. Chưa ghi gì vào Kho.',
    action: 'open_hub',
  },
  GEN_MEMORY_FULL: {
    text: 'Gen nhớ đã đủ 30 ghi chú — Sếp xoá bớt ở Cài đặt › Bộ não AI rồi xác nhận lại.',
    action: 'open_memory',
  },
  GEN_MEMORY_DUPLICATE: {
    text: 'Ghi chú này đã có trong Gen nhớ — không cần ghi lại.',
    action: 'open_memory',
  },
  GEN_PROPOSAL_DECIDED: {
    text: 'Đề xuất này đã được xác nhận hoặc đã huỷ ở nơi khác — tải lại hội thoại để xem kết quả.',
    action: null,
  },
};

/** Câu thân thiện + nút kèm theo cho mã lỗi của Ghi nhớ / Ghi vào Kho; mã khác ⇒ null (dùng `errorText` chung). */
export function proposalErrorView(e: unknown): ProposalErrorView | null {
  if (!(e instanceof ApiError)) return null;
  return ERROR_VIEW[e.code] ?? null;
}
