import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { InboxItem, InboxTab } from '@gen-harness/contracts';
import { Button, Card, Dialog, EmptyState, FilterSelect, Skeleton, Tabs, TextField, type TabItem } from '@gen-harness/ui';
import { WhyButton } from '../core/Evidence';
import { errorText } from '../../lib/errorText';
import { fmtAgo } from '../../lib/format';
import { useUrlState } from '../../lib/uiStore';
import { CardError, InlineError, ScreenHead } from '../common';
import { confidenceTone, itemTag, itemTagTone, priorityTone } from './queueModel';
import { useInbox, useInboxAct, useInboxAssign, useInboxSilence } from './queries';

const INTENT_OPTIONS = [
  { value: '', label: 'Tất cả' },
  { value: 'AskedPrice', label: 'Hỏi giá' },
  { value: 'OfferedSupply', label: 'Chào bán' },
  { value: 'RequestedPartnership', label: 'Đề nghị hợp tác' },
  { value: 'Complained', label: 'Than phiền' },
  { value: 'ScheduledMeeting', label: 'Hẹn gặp' },
  { value: 'SentQuotation', label: 'Đã gửi báo giá' },
  { value: 'PromisedDelivery', label: 'Cam kết giao hàng' },
  { value: 'MentionsCompetitor', label: 'Nhắc đối thủ' },
];

/** Đội ngũ tạm để giao việc — chưa có màn Danh mục người dùng (GĐ 4), nên đây là danh sách rút gọn tại chỗ. */
const TEAMMATES = [
  { id: 'u-lan', name: 'Chị Lan Phạm' },
  { id: 'u-minh', name: 'Anh Minh Kiểm' },
  { id: 'u-me', name: 'Tôi' },
];

export function InboxScreen() {
  const [tab, setTab] = useUrlState<InboxTab>('tab', 'all');
  const [intent, setIntent] = useUrlState<string>('intent', '');
  const q = useInbox(tab, intent);
  const [assignFor, setAssignFor] = useState<InboxItem | null>(null);
  const [silenceFor, setSilenceFor] = useState<InboxItem | null>(null);

  const items: TabItem<InboxTab>[] = (
    [
      ['all', 'Tất cả'],
      ['opportunity', 'Cơ hội'],
      ['alert', 'Cảnh báo'],
      ['approval', 'Chờ duyệt'],
      ['reply', 'Cần soạn'],
      ['candidate', 'Ứng viên'],
    ] as const
  ).map(([key, label]) => ({ key, label, count: q.data?.counts[key] }));

  return (
    <div className="screen">
      <ScreenHead
        title="Hộp thư ý nghĩa"
        description="Không phải tin nhắn thô. Mỗi dòng là một đơn vị ý nghĩa đã được cấu trúc: nguồn, đối tượng, điểm số, tóm tắt hai câu, hành động đề xuất và chứng cứ gốc."
        maxWidth={700}
        actions={
          <FilterSelect label="Ý định" value={intent} onChange={setIntent} options={INTENT_OPTIONS} />
        }
      />
      <Tabs items={items} value={tab} onChange={setTab} label="Tab hộp thư" idPrefix="inbox-tab" />

      {q.isPending ? (
        <div className="ib-list">
          {Array.from({ length: 4 }, (_, i) => (
            <Card key={i}>
              <Skeleton width={120} height={12} />
              <Skeleton width="70%" height={16} style={{ marginTop: 10 }} />
              <Skeleton width="90%" height={10} style={{ marginTop: 8 }} />
            </Card>
          ))}
        </div>
      ) : q.isError ? (
        <CardError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : q.data.items.length === 0 ? (
        <EmptyState
          icon="ph ph-tray"
          title="Hộp thư đang trống"
          description="Không có đơn vị ý nghĩa, cảnh báo hay bản nháp nào khớp bộ lọc hiện tại."
        />
      ) : (
        <div className="ib-list">
          {q.data.items.map((item) => (
            <InboxCard key={item.id} item={item} onAssign={() => setAssignFor(item)} onSilence={() => setSilenceFor(item)} />
          ))}
        </div>
      )}

      {assignFor ? <AssignDialog item={assignFor} onClose={() => setAssignFor(null)} /> : null}
      {silenceFor ? <SilenceDialog item={silenceFor} onClose={() => setSilenceFor(null)} /> : null}
    </div>
  );
}

function InboxCard({ item, onAssign, onSilence }: { item: InboxItem; onAssign: () => void; onSilence: () => void }) {
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState('');
  const act = useInboxAct();

  const submitReply = () => {
    if (!text.trim()) return;
    act.mutate(
      { id: item.id, body: { text } },
      {
        onSuccess: () => {
          setComposing(false);
          setText('');
        },
      },
    );
  };

  return (
    <article className="ib-card" aria-label={item.title}>
      <div className="ib-card__head">
        <span className="ib-card__prio" style={{ color: priorityTone(item.priority) }}>
          {item.priority}
        </span>
        <span className="ib-card__tag" style={{ color: itemTagTone(item), borderColor: itemTagTone(item) }}>
          {itemTag(item)}
        </span>
        {item.code ? <span className="mono">{item.code}</span> : null}
        {item.group ? <span className="ib-card__meta">{item.group.name}</span> : null}
        <span className="ib-card__meta">{fmtAgo(item.created_at)}</span>
        <span style={{ flex: 1 }} />
        {item.score !== null ? (
          <span className="ib-card__score">
            <b>{Math.round(item.score * 100)}</b>/100
          </span>
        ) : null}
        {item.confidence_band ? (
          <span className="ib-card__conf" style={{ color: confidenceTone(item.confidence_band) }}>
            tin cậy {item.confidence_band}
          </span>
        ) : null}
      </div>
      <h3 className="ib-card__title">{item.summary || item.title}</h3>
      {item.suggested_action ? <p className="ib-card__suggest">Gợi ý: {item.suggested_action}</p> : null}

      {composing ? (
        <div className="ib-compose">
          <TextField label="Nội dung trả lời" value={text} onChange={(e) => setText(e.target.value)} placeholder="Soạn nội dung gửi cho khách…" />
          <div className="ib-compose__actions">
            <Button variant="primary" icon="ph ph-paper-plane-tilt" loading={act.isPending} onClick={submitReply} disabled={!text.trim()}>
              Tạo bản nháp trả lời
            </Button>
            <Button variant="ghost" onClick={() => setComposing(false)}>
              Huỷ
            </Button>
          </div>
          {act.isError ? <InlineError>{errorText(act.error)}</InlineError> : null}
        </div>
      ) : (
        <div className="ib-card__actions">
          {item.item_type === 'unit' ? (
            <Button variant="secondary" icon="ph ph-chat-circle-text" onClick={() => setComposing(true)}>
              Soạn trả lời
            </Button>
          ) : item.item_type === 'alert' ? (
            <Button
              variant="secondary"
              icon="ph ph-check-circle"
              loading={act.isPending}
              onClick={() => act.mutate({ id: item.id, body: { create_task: true } })}
            >
              Xác nhận đã xử lý + tạo việc theo dõi
            </Button>
          ) : (
            <Link to={`/workbench?id=${encodeURIComponent(item.id)}`} className="gh-btn gh-btn--secondary">
              Mở trong Bàn làm việc
            </Link>
          )}
          <Button variant="ghost" icon="ph ph-user-switch" onClick={onAssign}>
            Giao cho người khác
          </Button>
          <Button variant="ghost" icon="ph ph-speaker-slash" onClick={onSilence}>
            Im lặng có chủ đích
          </Button>
          <span style={{ flex: 1 }} />
          <WhyButton kind={item.item_type === 'unit' ? 'meaning_unit' : item.item_type} id={item.id} size="sm">
            Vì sao hệ thống nghĩ vậy
          </WhyButton>
        </div>
      )}
      {act.isError && !composing ? <InlineError>{errorText(act.error)}</InlineError> : null}
    </article>
  );
}

function AssignDialog({ item, onClose }: { item: InboxItem; onClose: () => void }) {
  const assign = useInboxAssign();
  return (
    <Dialog
      open
      onClose={onClose}
      width={380}
      title="Giao cho người khác"
      kicker={item.title}
      actions={
        <Button variant="secondary" onClick={onClose}>
          Đóng
        </Button>
      }
    >
      <div className="dlg-list" role="list">
        {TEAMMATES.map((u) => (
          <button
            key={u.id}
            type="button"
            className="sv-open"
            disabled={assign.isPending}
            onClick={() =>
              assign.mutate(
                { id: item.id, userId: u.id },
                {
                  onSuccess: onClose,
                },
              )
            }
          >
            <span className="sv-open__name">{u.name}</span>
          </button>
        ))}
      </div>
      {assign.isError ? <InlineError>{errorText(assign.error)}</InlineError> : null}
    </Dialog>
  );
}

function SilenceDialog({ item, onClose }: { item: InboxItem; onClose: () => void }) {
  const silence = useInboxSilence();
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open
      onClose={onClose}
      width={420}
      title="Im lặng có chủ đích"
      kicker={item.title}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            variant="primary"
            icon="ph ph-speaker-slash"
            loading={silence.isPending}
            onClick={() => silence.mutate({ id: item.id, reason: reason || null, until: null }, { onSuccess: onClose })}
          >
            Im lặng mục này
          </Button>
        </>
      }
    >
      <div className="dlg-fields">
        <TextField label="Lý do (không bắt buộc)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Đã xử lý ngoài hệ thống, không cần nhắc lại…" />
        {silence.isError ? <InlineError>{errorText(silence.error)}</InlineError> : null}
      </div>
    </Dialog>
  );
}
