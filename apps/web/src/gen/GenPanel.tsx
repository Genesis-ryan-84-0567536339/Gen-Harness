import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { GEN_SCREEN_BY_KEY, GEN_TARGET_BY_ID, splitTargetId, type GenStep, type UiAction } from '@gen-harness/contracts';
import { Button, Icon, IconButton } from '@gen-harness/ui';
import { useMe } from '../lib/queries';
import { BriefingHubSections } from './BriefingHubSections';
import { hubCardsAt } from './briefingModel';
import { closeSpotlight, executeUiAction } from './director';
import { restoreIfNeeded, retryRestore, sendFeedback, sendQuestion } from './genClient';
import { GenHistory } from './GenHistory';
import { ProposalCard } from './ProposalCard';
import { toolLabel } from './toolLabels';
import { useGenStore, type GenChatMessage } from './genStore';

const EXAMPLES = ['Hôm nay có gì cần tôi xử lý?', 'Khách nào hỏi giá hôm nay?', 'Nhắc tôi gọi lại khách lúc 3 giờ chiều'];

function targetLabel(id: string): string {
  return GEN_TARGET_BY_ID[splitTargetId(id).base]?.label ?? id;
}

function actionLabel(a: UiAction): string {
  if (a.type === 'navigate') return `Đã mở ${GEN_SCREEN_BY_KEY[a.screen]?.title ?? a.screen}`;
  if (a.type === 'highlight') return `Đang chỉ: ${targetLabel(a.target)}`;
  return `Dẫn ${a.steps.length} bước`;
}

/** Hiện câu Gen chào theo cách xưng hô đã chọn ở trình thiết lập ("Sếp"). */
function useAddressing(): string {
  const me = useMe();
  return me.data?.addressing?.bot_calls_me || 'Sếp';
}

function Step({ step, turnId }: { step: GenStep; turnId?: string }) {
  if (step.kind === 'say') return <p className="gen-msg__text">{step.text}</p>;
  if (step.kind === 'tool')
    return (
      <span className="gen-chip">
        <Icon name="ph ph-magnifying-glass" size={11} /> Đã tra {toolLabel(step.name)}
      </span>
    );
  if (step.kind === 'ui')
    return (
      <button type="button" className="gen-chip gen-chip--btn" onClick={() => void executeUiAction(step.action, turnId)} title="Làm lại">
        <Icon name={step.action.type === 'navigate' ? 'ph ph-arrow-square-out' : 'ph ph-cursor-click'} size={11} /> {actionLabel(step.action)}
      </button>
    );
  if (step.kind === 'proposal') return <ProposalCard proposal={step.proposal} />;
  if (step.kind === 'suggest')
    return (
      <div className="gen-suggest">
        {step.items.map((it) => (
          <button key={it.label} type="button" className="gh-btn gh-btn--secondary btn-24" onClick={() => void executeUiAction(it.action, turnId)}>
            {it.label}
          </button>
        ))}
      </div>
    );
  return null;
}

/** v0.1.41 (F-86): Hữu ích / Không hữu ích cho một câu trả lời đã xong (bấm lại nút đang chọn ⇒ bỏ đánh giá). */
function Feedback({ m }: { m: GenChatMessage }) {
  return (
    <div className="gen-rate" role="group" aria-label="Đánh giá câu trả lời">
      <button type="button" className="gen-rate__btn" aria-pressed={m.feedback === 'helpful'} onClick={() => void sendFeedback(m, 'helpful')}>
        <Icon name={m.feedback === 'helpful' ? 'ph-fill ph-thumbs-up' : 'ph ph-thumbs-up'} size={12} /> Hữu ích
      </button>
      <button type="button" className="gen-rate__btn" aria-pressed={m.feedback === 'not_helpful'} onClick={() => void sendFeedback(m, 'not_helpful')}>
        <Icon name={m.feedback === 'not_helpful' ? 'ph-fill ph-thumbs-down' : 'ph ph-thumbs-down'} size={12} /> Không hữu ích
      </button>
    </div>
  );
}

function Message({ m, userId }: { m: GenChatMessage; userId?: string }) {
  if (m.role === 'user') return <div className="gen-msg gen-msg--user">{m.text}</div>;
  const steps = m.steps.filter(Boolean);
  const rateable = m.status === 'done' && !!m.turnId;
  // v0.1.49 (F-8, QD-16): thẻ Lịch hôm nay / Mail cần trả lời / Việc Google đang mở (Gen-hub, chỉ đọc) chèn ngay sau
  // "Sự cố cần Sếp" — trước Facebook/Kho và các lời nhắc + nút.
  const hubAt = m.kind === 'briefing' ? hubCardsAt(steps, m.hubAt) : steps.length;
  return (
    <div className={m.kind === 'briefing' ? 'gen-msg gen-msg--gen gen-msg--briefing' : 'gen-msg gen-msg--gen'} aria-busy={m.status === 'running' || undefined}>
      {m.kind === 'briefing' ? (
        <span className="gen-badge">
          <Icon name="ph ph-newspaper" size={11} /> Bản tin
        </span>
      ) : null}
      {steps.slice(0, hubAt).map((s, i) => (
        <Step key={i} step={s} turnId={m.turnId} />
      ))}
      {m.kind === 'briefing' ? <BriefingHubSections sections={m.sections} /> : null}
      {steps.slice(hubAt).map((s, i) => (
        <Step key={hubAt + i} step={s} turnId={m.turnId} />
      ))}
      {typeof m.detail === 'string' && m.detail ? (
        <details className="tech-detail">
          <summary>Chi tiết kỹ thuật</summary>
          <code>{m.detail}</code>
        </details>
      ) : null}
      {m.retryConversation && userId ? (
        <Button variant="secondary" size="sm" icon="ph ph-arrow-clockwise" onClick={() => void retryRestore(m.retryConversation as string, userId)}>
          Thử lại
        </Button>
      ) : null}
      {m.status === 'running' ? (
        <span className="gen-thinking" role="status">
          <span />
          <span />
          <span /> Gen đang nghĩ…
        </span>
      ) : null}
      {rateable ? <Feedback m={m} /> : null}
    </div>
  );
}

/**
 * Khung chat Gen bên phải (docs/design/gen-v1.md §3.1). Bật/tắt bằng nút ở Header; trên điện thoại là tấm phủ toàn
 * màn hình. Câu trả lời, "đang nghĩ", chip hành động (bấm để chỉ lại), gợi ý; v2 (A4): thẻ đề xuất thao tác có
 * Xác nhận / Sửa / Huỷ (ProposalCard) — Gen không tự ghi gì.
 */
export function GenPanel({ userId }: { userId: string }) {
  const messages = useGenStore((s) => s.messages);
  const busy = useGenStore((s) => s.busy);
  const restoring = useGenStore((s) => s.restoring);
  // Đang tải nội dung hội thoại (tải lại trang, mở từ "Hội thoại cũ" hay bản tin từ chuông) ⇒ khoá gửi + "Đang mở…".
  const loadingConversation = useGenStore((s) => s.loadingConversation);
  const opening = restoring || loadingConversation;
  const setOpen = useGenStore((s) => s.setOpen);
  const reset = useGenStore((s) => s.reset);
  const addr = useAddressing();
  const [text, setText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyBtnRef = useRef<HTMLButtonElement>(null);

  // v0.1.41 (F-8a): tải lại trang ⇒ mở lại hội thoại đã lưu (một lần; đang trả lời thì không đụng).
  useEffect(() => {
    if (!useGenStore.getState().busy) void restoreIfNeeded(userId);
  }, [userId]);

  const closeHistory = () => {
    setHistoryOpen(false);
    historyBtnRef.current?.focus();
  };

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (q = text) => {
    const st = useGenStore.getState();
    if (!q.trim() || busy || st.restoring || st.loadingConversation) return;
    setText('');
    // v0.1.28 (UX V12): câu hỏi mới → dừng lượt dẫn đường cũ (ô khoanh sáng không còn đè màn hình).
    if (useGenStore.getState().spotlight) closeSpotlight();
    void sendQuestion(q, userId);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    // Esc: đang làm sáng thì chỉ tắt lớp phủ (Spotlight tự xử lý), không đóng khung chat.
    if (e.key === 'Escape' && !useGenStore.getState().spotlight) setOpen(userId, false);
  };

  return (
    <aside className="gen-panel" aria-label="Gen — trợ lý quản trị">
      <div className="gen-panel__head">
        <span className="gen-panel__logo" aria-hidden>
          <Icon name="ph-fill ph-sparkle" size={14} />
        </span>
        <div className="gen-panel__titles">
          <div className="gen-panel__title">Gen</div>
          <div className="gen-panel__sub">Trợ lý quản trị · dẫn đường &amp; đề xuất có xác nhận</div>
        </div>
        <IconButton
          ref={historyBtnRef}
          icon="ph ph-clock-counter-clockwise"
          label="Hội thoại cũ"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((v) => !v)}
        />
        <IconButton icon="ph ph-plus" label="Hội thoại mới" onClick={reset} disabled={busy || opening} />
        <IconButton icon="ph ph-x" label="Đóng khung Gen" onClick={() => setOpen(userId, false)} />
      </div>
      {historyOpen ? <GenHistory userId={userId} onClose={closeHistory} /> : null}
      <div className="gen-panel__list" ref={listRef} aria-live="polite">
        {messages.length === 0 && opening ? (
          <p className="gen-empty" role="status">
            {restoring ? 'Đang mở lại hội thoại…' : 'Đang mở hội thoại…'}
          </p>
        ) : messages.length === 0 ? (
          <div className="gen-empty">
            <p>
              Chào {addr}, em là Gen. {addr} hỏi về tình hình hôm nay, nhờ em chỉ chỗ bấm, hoặc nhờ em soạn nháp tin, đặt
              nhắc việc, giao người — em chỉ đề xuất, {addr} xác nhận thì em mới làm.
            </p>
            <div className="gen-suggest">
              {EXAMPLES.map((q) => (
                <button key={q} type="button" className="gh-btn gh-btn--secondary btn-24" onClick={() => submit(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => <Message key={m.id} m={m} userId={userId} />)
        )}
      </div>
      <form
        className="gen-panel__input"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={inputRef}
          className="gh-input"
          rows={2}
          value={text}
          maxLength={4000}
          placeholder={`${addr} hỏi Gen…`}
          aria-label="Câu hỏi cho Gen"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <IconButton icon="ph ph-paper-plane-right" label="Gửi" variant="primary" type="submit" disabled={busy || opening || !text.trim()} />
      </form>
    </aside>
  );
}
