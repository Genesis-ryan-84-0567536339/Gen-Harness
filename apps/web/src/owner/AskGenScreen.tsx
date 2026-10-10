/**
 * v0.1.55 (G5) — `/owner/gen`: màn Hỏi Gen. NHÚNG nguyên `GenPanel` của Console (không đổi props, không chép logic): trên
 * điện thoại Gen chiếm cả màn; trên máy tính là panel bên phải, bên trái là vài câu gợi ý (bấm chỉ ĐIỀN SẴN ô nhập, không
 * gửi). Gen tắt ⇒ giải thích + link Bộ não AI. Gen chỉ đề xuất; thao tác ghi vẫn cần Xác nhận (+ mã PIN) trên thẻ đề xuất.
 */
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Icon, Skeleton } from '@gen-harness/ui';
import { GenPanel } from '../gen/GenPanel';
import { useGenStore } from '../gen/genStore';
import { useMe } from '../lib/queries';
import { Panel } from '../screens/common';
import { ASK_GEN_PROMPTS } from './ownerModel';
import { OwnerEmpty, OwnerError } from './parts';

export function AskGenScreen() {
  const me = useMe();
  useEffect(() => {
    document.title = 'Hỏi Gen · Gen-Harness';
  }, []);

  if (me.isPending) {
    return (
      <div className="owner-screen" aria-busy="true" data-testid="owner-loading">
        <Skeleton width="100%" height={360} radius={14} />
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="owner-screen">
        <OwnerError error={me.error} onRetry={() => void me.refetch()} retrying={me.isFetching} />
      </div>
    );
  }
  if (!me.data.features?.gen) {
    return (
      <div className="owner-screen">
        <Panel title="Hỏi Gen" flush>
          <OwnerEmpty
            icon="ph ph-sparkle"
            title="Gen đang tắt"
            hint="Sếp bật Gen lại ở Bộ não AI để hỏi em ngay tại đây."
            actions={
              <Link to="/system?tab=brain" className="gh-btn gh-btn--secondary btn-24">
                Mở Bộ não AI
              </Link>
            }
          />
        </Panel>
      </div>
    );
  }
  return (
    <div className="owner-ask" data-testid="owner-ask">
      <aside className="owner-ask__side" aria-label="Gợi ý câu hỏi">
        <h2 className="owner-ask__title">Hỏi Gen gì?</h2>
        <p className="owner-muted">Em xem số liệu, chỉ chỗ bấm và soạn nháp giúp Sếp. Em chỉ đề xuất — Sếp xác nhận (và nhập mã PIN khi cần) em mới làm.</p>
        <div className="owner-ask__prompts">
          {ASK_GEN_PROMPTS.map((q) => (
            <button key={q} type="button" className="gh-btn gh-btn--secondary" onClick={() => useGenStore.getState().setComposerDraft(q)}>
              <Icon name="ph ph-chat-circle-text" size={14} /> {q}
            </button>
          ))}
        </div>
      </aside>
      <section className="owner-gen" aria-label="Khung chat với Gen" data-testid="owner-gen-panel">
        <GenPanel userId={me.data.id} />
      </section>
    </div>
  );
}
