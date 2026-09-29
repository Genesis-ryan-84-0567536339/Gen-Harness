/**
 * Gửi câu hỏi cho Gen và nhận câu trả lời từng bước. Nguồn chính: WS `gen.step`/`gen.done` (chỉ người hỏi nhận);
 * song song hỏi `GET /gen/turns/{id}` mỗi 1,2 s tới khi xong — WS rớt thì câu trả lời vẫn tới. Hai nguồn ghép theo
 * `seq`, bước `ui` chỉ thực thi MỘT lần và tuần tự (mở trang xong mới làm sáng).
 */
import { ApiError, type GenDoneEvent, GenStep, GenStepEvent, GenTurn } from '@gen-harness/contracts';
import { api } from '../lib/api';
import { errorText } from '../lib/errorText';
import { onRealtimeEvent } from '../lib/realtime';
import { currentScreenKey, executeUiAction, visibleTargets } from './director';
import { mergeStep, useGenStore } from './genStore';

export const POLL_MS = 1200;

let queue: Promise<void> = Promise.resolve();
const polling = new Set<string>();

function enqueue(fn: () => Promise<void>): void {
  queue = queue.then(fn).catch(() => undefined);
}

/** Bước WS tới trước khi `POST /gen/turns` trả về (chưa có tin trả lời để ghép) — giữ tạm rồi phát lại. */
const early = new Map<string, Array<Pick<GenStepEvent, 'turn_id' | 'seq' | 'step'>>>();

function hasTurn(turnId: string): boolean {
  return useGenStore.getState().messages.some((m) => m.role === 'assistant' && m.turnId === turnId);
}

export function applyStep(ev: Pick<GenStepEvent, 'turn_id' | 'seq' | 'step'>): void {
  if (!hasTurn(ev.turn_id)) {
    early.set(ev.turn_id, [...(early.get(ev.turn_id) ?? []), ev]);
    return;
  }
  if (!mergeStep(ev.turn_id, ev.seq, ev.step)) return;
  const step: GenStep = ev.step;
  if (step.kind === 'ui') enqueue(() => executeUiAction(step.action, ev.turn_id));
}

export function finishTurn(turnId: string, status: GenDoneEvent['status']): void {
  useGenStore.setState((s) => ({
    busy: s.messages.some((m) => m.turnId !== turnId && m.status === 'running'),
    messages: s.messages.map((m) => (m.turnId === turnId && m.role === 'assistant' ? { ...m, status } : m)),
  }));
  polling.delete(turnId);
}

function applyTurn(t: GenTurn): void {
  for (const ev of t.steps) applyStep(ev);
  if (t.status !== 'running') finishTurn(t.turn_id, t.status);
}

async function poll(turnId: string): Promise<void> {
  polling.add(turnId);
  while (polling.has(turnId)) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!polling.has(turnId)) return;
    try {
      applyTurn(await api.gen.turn(turnId));
    } catch {
      /* thử lại vòng sau; mất phiên thì api client tự chuyển trang đăng nhập */
    }
  }
}

export async function sendQuestion(text: string): Promise<void> {
  const q = text.trim();
  if (!q) return;
  const st = useGenStore.getState();
  const localId = `u-${Date.now()}`;
  useGenStore.setState({ busy: true, messages: [...st.messages, { id: localId, role: 'user', text: q, steps: [] }] });
  try {
    const res = await api.gen.createTurn({
      conversation_id: st.conversationId,
      text: q,
      context: { route: window.location.pathname + window.location.search, screen_key: currentScreenKey(), visible_targets: visibleTargets() },
    });
    useGenStore.setState((s) => ({
      conversationId: res.conversation_id,
      messages: [...s.messages, { id: `a-${res.turn_id}`, role: 'assistant', turnId: res.turn_id, steps: [], status: 'running' }],
    }));
    for (const ev of early.get(res.turn_id) ?? []) applyStep(ev);
    early.delete(res.turn_id);
    void poll(res.turn_id);
  } catch (e) {
    const msg =
      e instanceof ApiError && e.status === 409
        ? 'Gen đang trả lời câu trước — đợi xong rồi hỏi tiếp nhé.'
        : e instanceof ApiError && e.status === 429
          ? 'Hỏi hơi nhanh rồi — đợi vài phút rồi hỏi tiếp nhé.'
          : errorText(e);
    useGenStore.setState((s) => ({
      busy: false,
      messages: [...s.messages, { id: `e-${localId}`, role: 'assistant', status: 'failed', steps: [{ kind: 'say', text: msg || 'Không gửi được câu hỏi — thử lại sau.' }] }],
    }));
  }
}

/** Mở lại một hội thoại cũ (chỉ hiển thị, không chạy lại hành động UI). */
export async function loadConversation(id: string): Promise<void> {
  const msgs = await api.gen.messages(id);
  useGenStore.setState({
    conversationId: id,
    busy: false,
    messages: msgs.map((m) => ({ id: m.id, role: m.role, text: m.content.text, steps: m.content.steps ?? [], turnId: m.turn_id ?? undefined, status: 'done' as const })),
  });
}

export function stopAll(): void {
  polling.clear();
}

onRealtimeEvent('gen.step', (_qc, data) => applyStep(data as GenStepEvent));
onRealtimeEvent('gen.done', (_qc, data) => {
  const d = data as GenDoneEvent;
  if (!hasTurn(d.turn_id)) return; // polling của lượt đó sẽ tự nhận trạng thái cuối
  // Đối chiếu lần cuối với server (WS có thể đã lỡ bước khi vừa kết nối lại) rồi mới đóng lượt.
  void api.gen
    .turn(d.turn_id)
    .then(applyTurn)
    .catch(() => finishTurn(d.turn_id, d.status));
});
