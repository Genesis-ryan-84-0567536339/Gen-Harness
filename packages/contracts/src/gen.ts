/**
 * Gen v1 — trợ lý quản trị trong Console (docs/design/gen-v1.md §3.3). Envelope có kiểu dùng chung web + test; API có
 * Pydantic tương ứng (`apps/api/gh/gen/envelope.py`, `extra="forbid"`).
 *
 * Luồng: `POST /gen/turns` → 202 {turn_id}; mỗi bước đã được server kiểm tới qua WS `gen.step` (chỉ người hỏi nhận,
 * `to_user`), kết thúc bằng `gen.done`. `GET /gen/turns/{id}` là đường dự phòng (polling) khi WS rớt.
 */
import type { ApiClient } from './client';
import type { BrowserJobStatus } from './social';

export type DataToolName =
  | 'overview.summary'
  | 'queue.list'
  | 'draft.list'
  | 'draft.get'
  | 'profile.search'
  | 'profile.get'
  | 'opportunity.list'
  | 'people.care'
  | 'audit.list'
  | 'system.health'
  | 'guide.list'
  | 'screens.list'
  | 'task.list'
  | 'staff.list'
  | 'refinery.summary'
  | 'hub.kho_summary'
  | 'hub.kho_search'
  | 'hub.kho_get'
  | 'social.accounts'
  | 'social.read'
  /** v0.1.49 (QD-16): Tài liệu / Deal / Vụ việc nội bộ + lịch / việc / mail / Drive Google qua Gen-hub (chỉ Owner, chỉ đọc). */
  | 'document.list'
  | 'document.get'
  | 'deal.list'
  | 'deal.get'
  | 'case.list'
  | 'case.get'
  | 'hub.calendar'
  | 'hub.tasks'
  | 'hub.mail_search'
  | 'hub.mail_read'
  | 'hub.drive_search'
  /** v0.1.41 (F-8): bước đầu của Bản tin Gen — đánh dấu nội dung ngoài (việc, khách, nháp, sự cố…). */
  | 'briefing.sources';

export type UiAction =
  | { type: 'navigate'; screen: string; params?: Record<string, string> }
  | { type: 'highlight'; target: string; message: string; waitFor?: 'click' | 'none' }
  | { type: 'tour'; steps: TourStep[] };

export interface TourStep {
  /** Màn của bước (bỏ trống = màn của bước trước / màn đang mở). */
  screen?: string;
  target: string;
  message: string;
}

export interface Suggestion {
  label: string;
  action: UiAction;
}

/**
 * Gen v2 (A4) — đề xuất thao tác có xác nhận. Gen KHÔNG tự ghi: server kiểm đề xuất của model (quyền, mục tiêu
 * registry, id phải vừa thấy trong kết quả tool) rồi gửi thẻ này; chỉ khi người dùng bấm Xác nhận, web gọi
 * `POST /gen/proposals/{id}/confirm` và server thực hiện nhân danh người đó qua endpoint sẵn có (Action Log
 * actor=user, via=gen). `requires_pin` = mục tiêu registry nhạy cảm → API trả 423, client tự hỏi PIN rồi gửi lại.
 */
export type GenProposalType = 'draft_message' | 'reminder' | 'assign' | 'social_reply' | 'social_dm';
export type GenProposalStatus = 'pending' | 'confirmed' | 'cancelled';

export interface GenSubjectRef {
  type: 'person' | 'group';
  id: string;
}

export interface DraftMessageFields {
  title: string;
  text: string;
  subject?: GenSubjectRef | null;
}

export interface ReminderFields {
  title: string;
  /** ISO 8601 (UTC, hậu tố Z). */
  remind_at: string;
  due_at?: string | null;
  priority: 'P1' | 'P2' | 'P3';
  assignee_user_id?: string | null;
  subject?: GenSubjectRef | null;
}

export interface AssignFields {
  item_type: 'task' | 'inbox';
  item_id: string;
  user_id: string;
}

/**
 * v0.1.47 (F-79): gửi trả lời bình luận / nhắn tin Facebook. Gen KHÔNG tự gửi: chỉ khi Sếp bấm Xác nhận (+ mã PIN) máy chủ
 * mới xếp một việc `write` cho trình duyệt nền; `text` là nguyên văn sẽ được gửi.
 */
export interface SocialWriteFields {
  account_id: string;
  target_url: string;
  text: string;
}

export interface GenProposalResult {
  /** v0.1.47: `social_write` — `id` = job_id của việc gửi; web theo dõi qua `GET /social/jobs/{id}`. */
  type: 'draft' | 'task' | 'inbox_item' | 'social_write';
  id: string | null;
  code?: string | null;
  /** Màn xem kết quả (khoá GEN_SCREENS). */
  screen: string;
  /**
   * v0.1.43: chỉ với `type: 'draft'` — nháp có nơi gửi (target) nên duyệt ở Bàn làm việc sẽ gửi đi thật. Hiện API chỉ
   * gắn nơi gửi khi đối tượng là NHÓM; thiếu/false ⇒ web không ghi "Duyệt & gửi".
   */
  sendable?: boolean;
  /** v0.1.47: chỉ với `social_write` — trạng thái việc gửi lúc xác nhận (thường `queued`). */
  status?: BrowserJobStatus;
}

interface GenProposalBase {
  id: string;
  /** Tóm tắt do HỆ THỐNG viết từ các trường đã kiểm (không phải lời model). */
  summary: string;
  /**
   * Nhãn hiển thị: `user` (người được giao), `item` (việc/mục), `subject` (đối tượng). v0.1.47 (gửi Facebook): `account`
   * (tên tài khoản), `target` (bình luận/người nhận), `write_gate` (`open`|`locked`), `suspicious` (`'1'` = mục có dấu hiệu lừa đảo).
   */
  labels: Record<string, string>;
  /** Mục tiêu registry gắn với đề xuất (quyền + cờ nhạy cảm lấy từ đây). */
  target: string;
  requires_pin: boolean;
  status: GenProposalStatus;
  result?: GenProposalResult;
}

export type GenProposal =
  | (GenProposalBase & { type: 'draft_message'; fields: DraftMessageFields })
  | (GenProposalBase & { type: 'reminder'; fields: ReminderFields })
  | (GenProposalBase & { type: 'assign'; fields: AssignFields })
  | (GenProposalBase & { type: 'social_reply'; fields: SocialWriteFields })
  | (GenProposalBase & { type: 'social_dm'; fields: SocialWriteFields });

/** Trường người dùng được sửa trên thẻ trước khi xác nhận (còn lại giữ nguyên như lúc đề xuất). */
export const GEN_PROPOSAL_EDITABLE: Record<GenProposalType, readonly string[]> = {
  draft_message: ['title', 'text'],
  reminder: ['title', 'remind_at', 'due_at', 'priority', 'assignee_user_id'],
  assign: ['user_id'],
  social_reply: ['text'],
  social_dm: ['text'],
};

export interface GenAssignee {
  id: string;
  name: string;
  role: string | null;
  me: boolean;
}

export type GenStep =
  | { kind: 'say'; text: string }
  | { kind: 'tool'; name: DataToolName; args?: Record<string, unknown> }
  | { kind: 'ui'; action: UiAction }
  | { kind: 'suggest'; items: Suggestion[] }
  | { kind: 'proposal'; proposal: GenProposal }
  | { kind: 'done' };

/** Bước server đẩy xuống web (đã kiểm). `tool` chỉ báo tên — kết quả không gửi về trình duyệt. */
export interface GenStepEvent {
  turn_id: string;
  conversation_id: string;
  seq: number;
  step: GenStep;
}

export type GenTurnStatus = 'running' | 'done' | 'failed';

export interface GenDoneEvent {
  turn_id: string;
  conversation_id: string;
  status: GenTurnStatus;
}

export interface GenTurn {
  turn_id: string;
  conversation_id: string;
  status: GenTurnStatus;
  steps: GenStepEvent[];
}

export interface GenTurnContext {
  route: string;
  screen_key: string | null;
  visible_targets: string[];
}

export interface GenTurnBody {
  conversation_id?: string | null;
  text: string;
  context: GenTurnContext;
}

export interface GenConversation {
  id: string;
  title: string;
  created_at: string;
  last_at: string;
  /** v0.1.41 (F-8): `briefing` = hội thoại Bản tin Gen (07:30 / 17:30 giờ VN); máy chủ cũ không gửi ⇒ coi là `chat`. */
  kind?: 'chat' | 'briefing';
}

/** v0.1.41 (F-86): đánh giá câu trả lời / bản tin của Gen. */
export type GenRating = 'helpful' | 'not_helpful';

/** v0.1.41 (F-8): một mục của Bản tin Gen (việc tới hạn, khách nóng, nháp chờ duyệt, sự cố…). */
export interface GenBriefingSection {
  key: string;
  title: string;
  count: number;
  lines: string[];
  link: string;
  /**
   * v0.1.49 (F-8, QD-16): mục đọc từ Gen-hub (lịch hôm nay `calendar_today`, mail cần trả lời `mail_reply`, việc đang mở
   * `gtasks_open`). `state`: `ok` có dòng · `empty` không có gì · `error` chưa đọc được · `breaker` Gen-hub tạm không trả
   * lời. Máy chủ cũ không gửi ⇒ coi là `ok`. Mục chưa nối / thiếu quyền KHÔNG có trong danh sách (xem `hub_hint`).
   * Mục nội bộ đọc lỗi cũng mang `state: 'error'` (chỉ để chuông/Telegram không báo "Không có việc gì…"); web chỉ vẽ
   * thẻ cho mục `external`.
   */
  state?: 'ok' | 'empty' | 'error' | 'breaker';
  /** `true` = mục lấy từ Gen-hub (nội dung ngoài, đã che). */
  external?: boolean;
  /** Lỗi thô đã lọc bí mật (chỉ hiện trong "Chi tiết kỹ thuật"); luôn là chuỗi hoặc null. */
  detail?: string | null;
  /** v0.1.49: mục Gen-hub chạm trần số mục đọc (10) — có thể còn nhiều hơn `count` ⇒ hiện "10+". */
  more?: boolean;
}

export interface GenMessage {
  id: string;
  role: 'user' | 'assistant';
  turn_id: string | null;
  /**
   * user: `{text}`; assistant: `{steps: GenStep[]}`. v0.1.41 (F-8): bản tin thêm `kind: 'briefing'`, `slot_label`,
   * `needs_api_key`, `sections` (bước vẫn ở `steps`, bước tool `briefing.sources` đứng đầu).
   */
  content: {
    text?: string;
    steps?: GenStep[];
    kind?: 'briefing';
    slot?: string;
    slot_label?: string;
    summary_source?: 'model' | 'none';
    needs_api_key?: boolean;
    sections?: GenBriefingSection[];
    /** v0.1.49: một câu gợi ý khi mục Gen-hub bị ẩn (chưa nối / thiếu quyền) — null khi không có gì để nhắc. */
    hub_hint?: string | null;
    /** v0.1.49: vị trí trong `steps` để chèn thẻ mục Gen-hub (ngay sau "Sự cố cần Sếp"); máy chủ cũ không gửi. */
    hub_at?: number;
  };
  created_at: string;
  /** v0.1.41 (F-86): đánh giá của chính người xem cho lượt này (máy chủ cũ không gửi). */
  feedback?: GenRating | null;
}

export interface GenSettings {
  enabled: boolean;
  /** Vai trò được dùng Gen (v1: chỉ `owner`). */
  roles: string[];
  retention_days: number;
  /** Người đang xem có dùng được Gen không. */
  available: boolean;
  /** Có nguồn Jev (System One) đang bật — Gen dùng làm bộ quyết định nhanh. */
  decider: 'jev' | 'llm';
}

export type TourOutcome = 'done' | 'skipped' | 'target_missing';

export function genEndpoints(r: ApiClient['request']) {
  return {
    gen: {
      settings: (signal?: AbortSignal) => r<GenSettings>('/gen/settings', { signal }),
      updateSettings: (body: { enabled?: boolean; retention_days?: number }) =>
        r<GenSettings>('/gen/settings', { method: 'PATCH', body }),
      conversations: (signal?: AbortSignal) => r<GenConversation[]>('/gen/conversations', { signal }),
      messages: (id: string, signal?: AbortSignal) =>
        r<GenMessage[]>(`/gen/conversations/${encodeURIComponent(id)}/messages`, { signal }),
      removeConversation: (id: string) =>
        r<void>(`/gen/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      createTurn: (body: GenTurnBody) =>
        r<{ turn_id: string; conversation_id: string }>('/gen/turns', { method: 'POST', body }),
      turn: (id: string, signal?: AbortSignal) => r<GenTurn>(`/gen/turns/${encodeURIComponent(id)}`, { signal }),
      ack: (id: string, body: { step: number; outcome: TourOutcome }) =>
        r<void>(`/gen/turns/${encodeURIComponent(id)}/ack`, { method: 'POST', body }),
      assignees: (signal?: AbortSignal) => r<{ items: GenAssignee[] }>('/gen/assignees', { signal }),
      confirmProposal: (id: string, fields: Record<string, unknown> = {}) =>
        r<GenProposal>(`/gen/proposals/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: { fields } }),
      cancelProposal: (id: string) => r<GenProposal>(`/gen/proposals/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
      /** v0.1.41 (F-86): Hữu ích / Không hữu ích cho một lượt trả lời hoặc bản tin. */
      feedback: (body: { conversation_id: string; turn_id: string; rating: GenRating }) =>
        r<{ turn_id: string; rating: GenRating; kind: 'reply' | 'briefing' }>('/gen/feedback', { method: 'PUT', body }),
      clearFeedback: (turnId: string) => r<void>(`/gen/feedback/${encodeURIComponent(turnId)}`, { method: 'DELETE' }),
    },
  };
}
