/**
 * Gen v1 — trợ lý quản trị trong Console (docs/design/gen-v1.md §3.3). Envelope có kiểu dùng chung web + test; API có
 * Pydantic tương ứng (`apps/api/gh/gen/envelope.py`, `extra="forbid"`).
 *
 * Luồng: `POST /gen/turns` → 202 {turn_id}; mỗi bước đã được server kiểm tới qua WS `gen.step` (chỉ người hỏi nhận,
 * `to_user`), kết thúc bằng `gen.done`. `GET /gen/turns/{id}` là đường dự phòng (polling) khi WS rớt.
 */
import type { ApiClient } from './client';

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
  | 'social.read';

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
export type GenProposalType = 'draft_message' | 'reminder' | 'assign';
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

export interface GenProposalResult {
  type: 'draft' | 'task' | 'inbox_item';
  id: string | null;
  code?: string | null;
  /** Màn xem kết quả (khoá GEN_SCREENS). */
  screen: string;
}

interface GenProposalBase {
  id: string;
  /** Tóm tắt do HỆ THỐNG viết từ các trường đã kiểm (không phải lời model). */
  summary: string;
  /** Nhãn hiển thị: `user` (người được giao), `item` (việc/mục), `subject` (đối tượng). */
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
  | (GenProposalBase & { type: 'assign'; fields: AssignFields });

/** Trường người dùng được sửa trên thẻ trước khi xác nhận (còn lại giữ nguyên như lúc đề xuất). */
export const GEN_PROPOSAL_EDITABLE: Record<GenProposalType, readonly string[]> = {
  draft_message: ['title', 'text'],
  reminder: ['title', 'remind_at', 'due_at', 'priority', 'assignee_user_id'],
  assign: ['user_id'],
};

export interface GenAssignee {
  id: string;
  name: string;
  role: string | null;
  me: boolean;
}

export type GenStep =
  | { kind: 'say'; text: string }
  | { kind: 'tool'; name: DataToolName; args: Record<string, unknown> }
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
}

export interface GenMessage {
  id: string;
  role: 'user' | 'assistant';
  turn_id: string | null;
  /** user: `{text}`; assistant: `{steps: GenStep[]}`. */
  content: { text?: string; steps?: GenStep[] };
  created_at: string;
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
    },
  };
}
