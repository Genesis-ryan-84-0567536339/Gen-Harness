/**
 * Mock API Gen v1 (`apps/api/gh/gen/routes.py`) — trả lời theo KỊCH BẢN cố định để demo Console chạy offline
 * (`npm run dev:mock`) và cho Playwright. Bước đẩy qua WS `gen.step`/`gen.done` (cách nhau `stepMs`) và lưu cho
 * `GET /gen/turns/{id}` (đường dự phòng) — y như API thật. Chỉ Owner dùng được (cờ gen.enabled mặc định).
 *
 * Kịch bản theo từ khoá trong câu hỏi:
 *   "gấp" / "xử lý" / "hôm nay"   → tra Tổng quan, mở Tổng quan, làm sáng Hàng đợi, đề xuất
 *   "jev" / "khoá" / "model"      → tour 3 bước: tab Bộ não AI → thẻ Jev → nút Kiểm tra
 *   "sao lưu" / "backup"          → mở Dữ liệu & lưu trữ, làm sáng nút "Sao lưu ngay"
 *   "nhắc"                         → v2 (A4): thẻ đề xuất "Tạo nhắc việc" (Xác nhận / Sửa / Huỷ)
 *   "nháp"                         → v2 (A4): thẻ "Soạn nháp tin" CẦN PIN (xác nhận → 423 → hỏi PIN → gửi lại)
 *   "mạng xã hội" / "facebook"     → v0.1.39 (F-32): mở trang Tài khoản mạng xã hội (`navigate social`)
 *
 * Hook e2e (v0.1.27): `POST /api/v1/__mock/p3/gen/fireReminders` = worker `task_reminder_scan` tới giờ — mỗi
 * nhắc việc đã xác nhận → chuông `task.reminder` cho các Owner (một lần).
 *   còn lại                        → lời chào + gợi ý
 */
import { randomUUID } from 'node:crypto';
import type { GenProposal, GenStep } from '../../../packages/contracts/src/gen';
import type { P2Ctx } from './mock-phase2';
import { USER_IDS } from './mock-ids';

export interface MockGenOptions {
  emit: (type: string, data: unknown) => void;
  /** Khoảng cách giữa các bước (ms). */
  stepMs?: number;
  /** Chuông cho mọi Owner (như `notifications.notify` + `owner_ids` ở API thật). */
  notifyOwners?: (kind: string, title: string, body: string, link: string | null) => void;
}

interface Turn {
  turn_id: string;
  conversation_id: string;
  status: 'running' | 'done' | 'failed';
  steps: Array<{ turn_id: string; conversation_id: string; seq: number; step: GenStep }>;
}

interface Conversation {
  id: string;
  title: string;
  created_at: string;
  last_at: string;
  messages: Array<{ id: string; role: 'user' | 'assistant'; turn_id: string | null; content: { text?: string; steps?: GenStep[] }; created_at: string }>;
}

const OWNER_ID = USER_IDS.owner;

export function script(q: string): GenStep[] {
  const t = q.toLowerCase();
  if (/mạng xã hội|facebook/.test(t)) {
    return [
      { kind: 'say', text: 'Dạ, em mở trang Tài khoản mạng xã hội — Sếp thêm và đăng nhập Facebook ngay trong app.' },
      { kind: 'ui', action: { type: 'navigate', screen: 'social' } },
    ];
  }
  if (/nháp/.test(t)) {
    const proposal: GenProposal = {
      id: randomUUID(),
      type: 'draft_message',
      fields: { title: 'Báo giá ván MDF', text: 'Chào anh Bảo, bên em gửi báo giá ván MDF E1 17mm như anh hỏi ạ.' },
      summary: 'Soạn nháp tin \u201cBáo giá ván MDF\u201d gửi anh Bảo — vào Bàn làm việc chờ duyệt, không gửi ngay.',
      labels: { subject: 'Anh Bảo' },
      target: 'workbench.drafts',
      requires_pin: true,
      status: 'pending',
    };
    return [
      { kind: 'say', text: 'Dạ, em soạn sẵn nháp tin — Sếp xem rồi bấm Xác nhận (cần mã PIN) nhé.' },
      { kind: 'proposal', proposal },
    ];
  }
  if (/nhắc/.test(t)) {
    const remind = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const proposal: GenProposal = {
      id: randomUUID(),
      type: 'reminder',
      fields: { title: 'Gọi lại khách', remind_at: remind, due_at: null, priority: 'P2', assignee_user_id: OWNER_ID },
      summary: 'Tạo nhắc việc \u201cGọi lại khách\u201d (P2), nhắc sau 1 giờ nữa, giao cho Sếp.',
      labels: { user: 'Sếp' },
      target: 'tasks.new',
      requires_pin: false,
      status: 'pending',
    };
    return [
      { kind: 'say', text: 'Dạ, em đề xuất tạo nhắc việc — Sếp xem, sửa nếu cần rồi bấm Xác nhận nhé.' },
      { kind: 'proposal', proposal },
    ];
  }
  if (/jev|khoá|khóa|model/.test(t)) {
    return [
      { kind: 'say', text: 'Dạ, em dẫn Sếp 3 bước để thêm nguồn Jev cho Gen — Sếp bấm "Tiếp" sau mỗi bước.' },
      {
        kind: 'ui',
        action: {
          type: 'tour',
          steps: [
            { screen: 'system', target: 'system.tab.brain', message: 'Bước 1: mở tab "Bộ não AI" — nơi quản lý các nguồn model.' },
            { target: 'system.brain.jev', message: 'Bước 2: thẻ Jev — chọn địa chỉ OpenRouter, giữ model typesafe/jev-1.13, dán khoá API.' },
            { target: 'system.brain.jev.test', message: 'Bước 3: bấm để lưu và gọi thử; báo xanh là xong.' },
          ],
        },
      },
    ];
  }
  if (/sao lưu|backup/.test(t)) {
    return [
      { kind: 'say', text: 'Sao lưu nằm ở Điều khiển hệ thống › Dữ liệu & lưu trữ. Em mở và chỉ nút cho Sếp.' },
      { kind: 'ui', action: { type: 'navigate', screen: 'system', params: { tab: 'storage' } } },
      { kind: 'ui', action: { type: 'highlight', target: 'system.backup.now', message: 'Bấm "Sao lưu ngay" để tạo bản sao lưu mã hoá ngay lúc này.' } },
    ];
  }
  if (/gấp|xử lý|hôm nay|tình hình/.test(t)) {
    return [
      { kind: 'tool', name: 'overview.summary', args: {} },
      {
        kind: 'say',
        text: 'Hôm nay có 3 việc cần Sếp xem: 1 báo giá 82 triệu vượt ngưỡng đang chờ duyệt, 2 cảnh báo khách phản hồi chậm, và 4 cơ hội mới từ nhóm Zalo.',
      },
      { kind: 'ui', action: { type: 'navigate', screen: 'overview' } },
      { kind: 'ui', action: { type: 'highlight', target: 'overview.queue', message: 'Hàng đợi cần xử lý — mục trên cùng là quan trọng nhất.' } },
      {
        kind: 'suggest',
        items: [
          { label: 'Mở hộp thư', action: { type: 'navigate', screen: 'inbox' } },
          { label: 'Chỉ tôi sao lưu', action: { type: 'tour', steps: [{ screen: 'system', target: 'system.tab.storage', message: 'Mở tab "Dữ liệu & lưu trữ".' }, { target: 'system.backup.now', message: 'Bấm "Sao lưu ngay".' }] } },
        ],
      },
    ];
  }
  return [
    { kind: 'say', text: 'Dạ, em là Gen. Sếp có thể hỏi "hôm nay có gì gấp?", hoặc nhờ em chỉ chỗ bấm, ví dụ "chỉ tôi cách thêm khoá Jev".' },
    { kind: 'suggest', items: [{ label: 'Mở Tổng quan', action: { type: 'navigate', screen: 'overview' } }] },
  ];
}

export function createMock(opts: MockGenOptions) {
  const stepMs = opts.stepMs ?? 350;
  const settings = { enabled: true, roles: ['owner'], retention_days: 90 };
  const conversations = new Map<string, Conversation>();
  const turns = new Map<string, Turn>();
  const proposals = new Map<string, GenProposal>();
  const reminders: Array<{ title: string; code: string; priority: string; fired: boolean }> = [];
  let taskSeq = 998;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function run(turn: Turn, conv: Conversation, steps: GenStep[]) {
    steps.forEach((step, i) => {
      const t = setTimeout(() => {
        timers.delete(t);
        if (step.kind === 'proposal') proposals.set(step.proposal.id, step.proposal);
        const ev = { turn_id: turn.turn_id, conversation_id: turn.conversation_id, seq: i, step };
        turn.steps.push(ev);
        opts.emit('gen.step', ev);
        if (i === steps.length - 1) {
          turn.status = 'done';
          conv.messages.push({ id: randomUUID(), role: 'assistant', turn_id: turn.turn_id, content: { steps }, created_at: new Date().toISOString() });
          conv.last_at = new Date().toISOString();
          opts.emit('gen.done', { turn_id: turn.turn_id, conversation_id: turn.conversation_id, status: 'done' });
        }
      }, stepMs * (i + 1));
      timers.add(t);
    });
  }

  function handle(ctx: P2Ctx): boolean {
    const { method: m, path: p, body, reply, problem } = ctx;
    if (!p.startsWith('/gen/')) return false;
    const seg = p.split('/').filter(Boolean); // ['gen', ...]
    const available = settings.enabled && settings.roles.includes(ctx.role);
    if (seg[1] === 'settings') {
      if (m === 'PATCH') {
        if (ctx.role !== 'owner') return problem(403, 'FORBIDDEN', 'Chỉ Owner');
        if (typeof body.enabled === 'boolean') settings.enabled = body.enabled;
        if (typeof body.retention_days === 'number') settings.retention_days = body.retention_days;
      }
      return reply(200, { ...settings, available: settings.enabled && settings.roles.includes(ctx.role), decider: 'llm' });
    }
    if (!available) return problem(403, 'GEN_DISABLED', 'Gen chưa bật cho vai trò này');
    if (seg[1] === 'conversations' && seg.length === 2 && m === 'GET') {
      return reply(200, [...conversations.values()].map(({ messages: _m, ...c }) => c).sort((a, b) => b.last_at.localeCompare(a.last_at)));
    }
    if (seg[1] === 'conversations' && seg[3] === 'messages' && m === 'GET') {
      const c = conversations.get(seg[2]);
      return c ? reply(200, c.messages) : problem(404, 'NOT_FOUND', 'Không tồn tại');
    }
    if (seg[1] === 'conversations' && seg.length === 3 && m === 'DELETE') {
      conversations.delete(seg[2]);
      return reply(204);
    }
    if (seg[1] === 'turns' && seg.length === 2 && m === 'POST') {
      const text = String(body.text ?? '').trim();
      if (!text) return problem(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors: { text: 'Nhập câu hỏi' } });
      const now = new Date().toISOString();
      let conv = body.conversation_id ? conversations.get(String(body.conversation_id)) : undefined;
      if (body.conversation_id && !conv) return problem(404, 'NOT_FOUND', 'Không tồn tại');
      if (!conv) {
        conv = { id: randomUUID(), title: text.slice(0, 60), created_at: now, last_at: now, messages: [] };
        conversations.set(conv.id, conv);
      }
      const turn: Turn = { turn_id: randomUUID(), conversation_id: conv.id, status: 'running', steps: [] };
      conv.messages.push({ id: randomUUID(), role: 'user', turn_id: turn.turn_id, content: { text }, created_at: now });
      turns.set(turn.turn_id, turn);
      run(turn, conv, script(text));
      return reply(202, { turn_id: turn.turn_id, conversation_id: conv.id });
    }
    if (seg[1] === 'turns' && seg.length === 3 && m === 'GET') {
      const t = turns.get(seg[2]);
      return t ? reply(200, t) : problem(404, 'NOT_FOUND', 'Không tồn tại');
    }
    if (seg[1] === 'turns' && seg[3] === 'ack' && m === 'POST') return reply(204);
    if (seg[1] === 'assignees' && m === 'GET') {
      return reply(200, { items: [{ id: OWNER_ID, name: 'Sếp', role: 'Owner — Sếp', me: true }, { id: USER_IDS.lan, name: 'Chị Lan', role: 'Vận hành', me: false }] });
    }
    if (seg[1] === 'proposals' && m === 'POST' && (seg[3] === 'confirm' || seg[3] === 'cancel')) {
      const pr = proposals.get(seg[2]);
      if (!pr) return problem(404, 'NOT_FOUND', 'Đề xuất (có thể đã hết hạn) không tồn tại hoặc nằm ngoài phạm vi của bạn');
      if (pr.status !== 'pending') return problem(409, 'GEN_PROPOSAL_DECIDED', 'Đề xuất này đã được xác nhận hoặc đã huỷ');
      // Như API thật: thao tác nhạy cảm (nháp tin) → 423, web hỏi PIN rồi gửi lại.
      if (seg[3] === 'confirm' && pr.requires_pin && ctx.needPin()) {
        return problem(423, 'PIN_REQUIRED', 'Thao tác này cần nhập mã PIN', { detail: { operation: 'draft.create' } });
      }
      const code = pr.type === 'draft_message' ? 'ACT-0999' : `TSK-${String(++taskSeq).padStart(4, '0')}`;
      const result = pr.type === 'draft_message' ? { type: 'draft' as const, id: randomUUID(), code, screen: 'workbench' } : { type: 'task' as const, id: randomUUID(), code, screen: 'tasks' };
      const next: GenProposal =
        seg[3] === 'cancel'
          ? { ...pr, status: 'cancelled' }
          : ({ ...pr, fields: { ...pr.fields, ...((body.fields as object) ?? {}) }, status: 'confirmed', result } as GenProposal);
      proposals.set(pr.id, next);
      if (next.status === 'confirmed' && next.type === 'reminder') {
        reminders.push({ title: next.fields.title, code, priority: next.fields.priority ?? 'P2', fired: false });
      }
      return reply(200, next);
    }
    return problem(404, 'NOT_FOUND', 'Không tồn tại');
  }

  return {
    handle,
    hooks: {
      settings: () => settings,
      script: (b: unknown) => script(String((b as { text?: string })?.text ?? '')),
      /** Worker nhắc việc tới giờ: chuông cho Owner, mỗi nhắc một lần. */
      fireReminders: () => {
        let n = 0;
        for (const r of reminders) {
          if (r.fired) continue;
          r.fired = true;
          n += 1;
          opts.notifyOwners?.('task.reminder', `Nhắc việc: ${r.title}`, `${r.code} · ${r.priority}`, '/tasks');
        }
        return { fired: n };
      },
    },
    dispose: () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
