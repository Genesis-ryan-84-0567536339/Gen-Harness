import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { GEN_SCREEN_BY_KEY, GEN_TARGET_BY_ID, splitTargetId, type GenStep, type UiAction } from '@gen-harness/contracts';
import { Icon, IconButton } from '@gen-harness/ui';
import { useMe } from '../lib/queries';
import { closeSpotlight, executeUiAction } from './director';
import { sendQuestion } from './genClient';
import { ProposalCard } from './ProposalCard';
import { useGenStore, type GenChatMessage } from './genStore';

const EXAMPLES = ['Hôm nay có gì cần tôi xử lý?', 'Nhắc tôi gọi lại khách lúc 3 giờ chiều', 'Chỉ tôi cách thêm khoá Jev'];

const TOOL_LABEL: Record<string, string> = {
  'overview.summary': 'Tổng quan',
  'queue.list': 'Hộp thư ý nghĩa',
  'draft.list': 'bản nháp',
  'draft.get': 'bản nháp',
  'profile.search': 'tìm kiếm',
  'profile.get': 'hồ sơ',
  'opportunity.list': 'cơ hội',
  'people.care': 'chất lượng chăm sóc',
  'audit.list': 'nhật ký',
  'system.health': 'sức khoẻ hệ thống',
  'guide.list': 'hướng dẫn kết nối',
  'screens.list': 'danh mục màn',
  'task.list': 'việc & nhắc hẹn',
  'staff.list': 'danh sách người',
  'refinery.summary': 'lọc đầu Hộp thư',
  'hub.kho_summary': 'Kho tri thức (Gen-hub)',
  'hub.kho_search': 'Kho tri thức (Gen-hub)',
  'hub.kho_get': 'Kho tri thức (Gen-hub)',
  'social.accounts': 'tài khoản mạng xã hội',
  'social.read': 'đọc mạng xã hội',
};

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
        <Icon name="ph ph-magnifying-glass" size={11} /> Đã tra {TOOL_LABEL[step.name] ?? step.name}
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

function Message({ m }: { m: GenChatMessage }) {
  if (m.role === 'user') return <div className="gen-msg gen-msg--user">{m.text}</div>;
  const steps = m.steps.filter(Boolean);
  return (
    <div className="gen-msg gen-msg--gen" aria-busy={m.status === 'running' || undefined}>
      {steps.map((s, i) => (
        <Step key={i} step={s} turnId={m.turnId} />
      ))}
      {m.status === 'running' ? (
        <span className="gen-thinking" role="status">
          <span />
          <span />
          <span /> Gen đang nghĩ…
        </span>
      ) : null}
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
  const setOpen = useGenStore((s) => s.setOpen);
  const reset = useGenStore((s) => s.reset);
  const addr = useAddressing();
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (q = text) => {
    if (!q.trim() || busy) return;
    setText('');
    // v0.1.28 (UX V12): câu hỏi mới → dừng lượt dẫn đường cũ (ô khoanh sáng không còn đè màn hình).
    if (useGenStore.getState().spotlight) closeSpotlight();
    void sendQuestion(q);
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
        <IconButton icon="ph ph-plus" label="Hội thoại mới" onClick={reset} disabled={busy} />
        <IconButton icon="ph ph-x" label="Đóng khung Gen" onClick={() => setOpen(userId, false)} />
      </div>
      <div className="gen-panel__list" ref={listRef} aria-live="polite">
        {messages.length === 0 ? (
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
          messages.map((m) => <Message key={m.id} m={m} />)
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
        <IconButton icon="ph ph-paper-plane-right" label="Gửi" variant="primary" type="submit" disabled={busy || !text.trim()} />
      </form>
    </aside>
  );
}
