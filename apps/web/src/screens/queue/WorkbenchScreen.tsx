import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DraftDetail, DraftItem } from '@gen-harness/contracts';
import { Button, Card, EmptyState, Icon, Segmented, Skeleton, Switch, Tag, type Tone } from '@gen-harness/ui';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errorText';
import { fmtDMClock, fmtInt } from '../../lib/format';
import { useUrlState } from '../../lib/uiStore';
import { CardError, InlineError, Panel, SkeletonLines } from '../common';
import { WhyButton } from '../core/Evidence';
import { qk3, useDraft, useDrafts } from '../core/queries';

const KIND_TONE: Record<DraftItem['kind'], Tone> = {
  quotation: 'bad',
  contract: 'bad',
  message: 'accent',
  reminder: 'neutral',
  report: 'neutral',
  mcp_write: 'warn',
};

const LANGS: Array<{ value: 'vi' | 'en' | 'zh' | 'ja' | 'ko'; label: string }> = [
  { value: 'vi', label: 'VI' },
  { value: 'en', label: 'EN' },
  { value: 'zh', label: 'ZH' },
  { value: 'ja', label: 'JA' },
  { value: 'ko', label: 'KO' },
];

export function WorkbenchScreen() {
  const [id, setId] = useUrlState<string>('id', '');
  const list = useDrafts('pending');
  const draft = useDraft(id || null);

  useEffect(() => {
    if (!id && list.data?.items.length) setId(list.data.items[0].id);
  }, [id, list.data, setId]);

  return (
    <div className="screen">
      <div className="wb-grid">
        <Panel
          title="Chờ Sếp duyệt"
          kicker={list.data ? `${fmtInt(list.data.total)} bản nháp · tự trị mức 4` : 'Đang tải…'}
          bodyClass="wb-list"
        >
          {list.isPending ? (
            <SkeletonLines rows={5} padding="12px 16px" />
          ) : list.isError ? (
            <CardError error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
          ) : list.data.items.length === 0 ? (
            <EmptyState icon="ph ph-tray" title="Không có bản nháp nào chờ duyệt" />
          ) : (
            list.data.items.map((d) => (
              <button key={d.id} type="button" className="wb-list__row" aria-pressed={d.id === id} onClick={() => setId(d.id)}>
                <Tag tone={KIND_TONE[d.kind]}>{d.kind_label}</Tag>
                <span className="wb-list__title">{d.title}</span>
                <span className="wb-list__meta">
                  {d.agent ? d.agent.name : (d.created_by?.name ?? '—')} · {fmtDMClock(d.created_at)}
                </span>
              </button>
            ))
          )}
        </Panel>

        {!id ? (
          <Card className="wb-empty">
            <EmptyState icon="ph ph-pen-nib" title="Chọn một bản nháp để xem" description="Danh sách bên trái liệt kê mọi bản nháp đang chờ Sếp duyệt." />
          </Card>
        ) : draft.isPending ? (
          <Card>
            <SkeletonLines rows={6} />
          </Card>
        ) : draft.isError ? (
          <Card>
            <CardError error={draft.error} onRetry={() => void draft.refetch()} retrying={draft.isFetching} />
          </Card>
        ) : (
          <DraftDetailView d={draft.data} />
        )}
      </div>
    </div>
  );
}

function DraftDetailView({ d }: { d: DraftDetail }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(d.text);
  const [sides, setSides] = useState<Record<string, boolean>>(() => Object.fromEntries(d.side_actions.map((s) => [s.key, s.on])));
  const [translating, setTranslating] = useState(false);
  const [translated, setTranslated] = useState<{ lang: string; text: string } | null>(null);

  useEffect(() => {
    setText(d.text);
    setEditing(false);
    setTranslated(null);
    setSides(Object.fromEntries(d.side_actions.map((s) => [s.key, s.on])));
  }, [d.id, d.text, d.side_actions]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk3.drafts });
    void qc.invalidateQueries({ queryKey: qk3.draft(d.id) });
  };
  const approve = useMutation({
    mutationFn: () => api.drafts.approve(d.id, { side_actions: sides }),
    onSuccess: invalidate,
  });
  const editSend = useMutation({
    mutationFn: () => api.drafts.editSend(d.id, { text, side_actions: sides }),
    onSuccess: () => {
      setEditing(false);
      invalidate();
    },
  });
  const reject = useMutation({
    mutationFn: (reason: string | null) => api.drafts.reject(d.id, { reason }),
    onSuccess: invalidate,
  });
  const regenerate = useMutation({
    mutationFn: (instruction: string | null) => api.drafts.regenerate(d.id, instruction),
    onSuccess: invalidate,
  });
  const translate = useMutation({
    mutationFn: (lang: (typeof LANGS)[number]['value']) => api.drafts.translate(d.id, lang),
    onSuccess: (r) => setTranslated(r),
  });

  const decided = d.status !== 'pending';
  const busy = approve.isPending || editSend.isPending || reject.isPending;

  return (
    <Card className="wb-detail" padded={false}>
      <div className="wb-detail__head">
        <div>
          <h2 className="wb-detail__title">{d.title}</h2>
          <div className="wb-detail__meta">
            {d.code} · {d.agent ? `${d.agent.name} soạn` : d.created_by ? `${d.created_by.name} tạo` : 'Hệ thống tạo'} · {fmtDMClock(d.created_at)}
          </div>
        </div>
        <div className="wb-detail__head-actions">
          <Button variant="secondary" icon="ph ph-translate" onClick={() => setTranslating((v) => !v)}>
            Dịch
          </Button>
          <Button
            variant="secondary"
            icon="ph ph-arrow-clockwise"
            loading={regenerate.isPending}
            disabled={decided}
            onClick={() => regenerate.mutate(null)}
          >
            Soạn lại
          </Button>
        </div>
      </div>

      {translating ? (
        <div className="wb-translate">
          <Segmented options={LANGS} value={(translated?.lang as (typeof LANGS)[number]['value']) ?? 'vi'} onChange={(v) => translate.mutate(v)} label="Ngôn ngữ dịch" />
          {translate.isPending ? <Skeleton width="80%" height={12} /> : translated ? <p className="wb-translate__text">{translated.text}</p> : null}
          {translate.isError ? <InlineError>{errorText(translate.error)}</InlineError> : null}
        </div>
      ) : null}

      <div className="wb-detail__body">
        {editing ? (
          <textarea className="wb-textarea" value={text} onChange={(e) => setText(e.target.value)} rows={12} aria-label="Sửa nội dung bản nháp" />
        ) : (
          d.paragraphs.map((p, i) => (
            <p className="wb-para" key={i}>
              {p}
            </p>
          ))
        )}
      </div>

      {d.sources.length > 0 ? (
        <div className="wb-sources">
          <div className="wb-sources__title">
            <Icon name="ph ph-database" size={13} />
            Dữ liệu agent đã dùng — không có chỗ nào bịa
          </div>
          <div className="wb-sources__chips">
            {d.sources.map((s, i) =>
              s.ref ? (
                <WhyButton key={i} kind={s.ref.type} id={s.ref.id} icon="ph ph-link" size="sm">
                  {s.label}
                </WhyButton>
              ) : (
                <span key={i} className="wb-source-chip">
                  <Icon name="ph ph-file-text" size={12} />
                  {s.label}
                </span>
              ),
            )}
          </div>
        </div>
      ) : null}

      {d.side_actions.length > 0 ? (
        <div className="wb-sides">
          <div className="wb-sources__title">Tạo kèm theo — hành động đi cùng khi duyệt</div>
          {d.side_actions.map((s) => (
            <label key={s.key} className="wb-sides__row">
              <span>{s.label}</span>
              <Switch checked={sides[s.key] ?? s.on} onChange={(v) => setSides((prev) => ({ ...prev, [s.key]: v }))} label={s.label} />
            </label>
          ))}
        </div>
      ) : null}

      <div className="wb-footer">
        {decided ? (
          <div className="wb-footer__decided">
            <Tag tone={d.status === 'rejected' || d.status === 'failed' ? 'bad' : 'ok'}>{d.status}</Tag>
            {d.decision ? (
              <span>
                bởi {d.decision.by.name} · {fmtDMClock(d.decision.at)}
                {d.decision.reason ? ` · ${d.decision.reason}` : ''}
              </span>
            ) : null}
          </div>
        ) : editing ? (
          <>
            <Button variant="primary" icon="ph ph-paper-plane-tilt" loading={editSend.isPending} disabled={!text.trim()} onClick={() => editSend.mutate()}>
              Gửi nội dung đã sửa
            </Button>
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Huỷ sửa
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" icon="ph ph-paper-plane-tilt" loading={approve.isPending} disabled={busy} onClick={() => approve.mutate()}>
              {d.approve_label}
            </Button>
            <Button variant="secondary" icon="ph ph-pencil-simple" disabled={busy} onClick={() => setEditing(true)}>
              Sửa rồi gửi
            </Button>
            <Button variant="ghost" icon="ph ph-x" loading={reject.isPending} disabled={busy} onClick={() => reject.mutate(null)}>
              Huỷ bản nháp
            </Button>
            {d.hold_reason ? <span className="wb-footer__hold">{d.hold_reason}</span> : null}
          </>
        )}
      </div>
      {approve.isError ? <InlineError>{errorText(approve.error)}</InlineError> : null}
      {editSend.isError ? <InlineError>{errorText(editSend.error)}</InlineError> : null}
      {reject.isError ? <InlineError>{errorText(reject.error)}</InlineError> : null}
    </Card>
  );
}
