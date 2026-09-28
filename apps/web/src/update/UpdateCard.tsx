import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, type SystemUpdate } from '@gen-harness/contracts';
import { Button, Dialog, Icon } from '@gen-harness/ui';
import { api } from '../lib/api';
import { errorText } from '../lib/errorText';
import { queryClient } from '../lib/queryClient';
import { Panel } from '../screens/common';
import { UPDATE_COMMAND, UPDATE_KEY, updateView } from './updateModel';

/**
 * Thẻ "Có bản mới" ở Tổng quan: bấm "Cập nhật ngay" để genh trên máy chủ tự sao lưu → tải bản mới → khởi động lại
 * (gh/system_api/update.py). Trong lúc cập nhật api khởi động lại nên các lần hỏi trạng thái có thể lỗi mạng — coi là
 * "đang khởi động lại", không phải lỗi. Xong thì tự tải lại trang để chạy giao diện bản mới.
 */
export function UpdateCard() {
  /** Bản Owner đã bấm cập nhật lên (giữ qua lúc api tắt/bật). */
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const reloaded = useRef(false);
  const q = useQuery({
    queryKey: UPDATE_KEY,
    queryFn: ({ signal }) => api.systemUpdate.get(signal),
    retry: false,
    refetchInterval: (query) => {
      const s = query.state.data?.state;
      return waitingFor || s === 'requested' || s === 'running' ? 4000 : false;
    },
  });
  const request = useMutation({
    mutationFn: () => api.systemUpdate.request(),
    onSuccess: (data) => {
      queryClient.setQueryData(UPDATE_KEY, data);
      setWaitingFor(data.latest ?? 'bản mới');
      setConfirm(false);
    },
  });

  const view = updateView(q.data, { waitingFor, offline: !!waitingFor && q.isError });

  useEffect(() => {
    if (view.kind === 'finished' && waitingFor && !reloaded.current) {
      reloaded.current = true;
      window.setTimeout(() => window.location.reload(), 1500);
    }
  }, [view.kind, waitingFor]);

  if (view.kind === 'hidden') return null;
  // Không phải Owner/quản trị (403) hay api chưa có tính năng này: im lặng.
  if (q.isError && !waitingFor && !(q.error instanceof ApiError && q.error.status === 0)) return null;
  const d = q.data as SystemUpdate | undefined;

  return (
    <Panel
      title={view.title}
      kicker={view.kicker}
      label="Cập nhật phiên bản"
      bodyClass="upd"
      className={`upd-card upd-card--${view.tone}`}
      aside={
        view.kind === 'available' && d?.can_request ? (
          <Button variant="primary" icon="ph ph-arrow-circle-up" className="btn-30" onClick={() => setConfirm(true)}>
            Cập nhật ngay
          </Button>
        ) : view.kind === 'failed' || view.kind === 'stalled' ? (
          d?.can_request ? (
            <Button variant="secondary" icon="ph ph-arrow-clockwise" className="btn-30" loading={request.isPending} onClick={() => request.mutate()}>
              Thử lại
            </Button>
          ) : null
        ) : null
      }
    >
      {view.kind === 'working' ? (
        <ol className="upd-steps" aria-live="polite">
          {view.steps.map((s) => (
            <li key={s.label} data-state={s.state}>
              <Icon name={s.state === 'done' ? 'ph ph-check' : s.state === 'active' ? 'ph ph-circle-notch' : 'ph ph-circle'} size={13} />
              {s.label}
            </li>
          ))}
        </ol>
      ) : null}
      {view.body ? <p className="upd-body">{view.body}</p> : null}
      {view.showCommand ? (
        <div className="upd-cmd">
          <span>Chạy lệnh này một lần trên máy chủ (lần sau chỉ cần bấm nút ở đây):</span>
          <code className="mono">{UPDATE_COMMAND}</code>
        </div>
      ) : null}
      {view.kind === 'available' && d?.release_notes ? (
        <details className="upd-notes">
          <summary>Có gì mới trong {d.latest}</summary>
          <pre>{d.release_notes}</pre>
        </details>
      ) : null}
      {request.isError ? <p className="upd-error">{errorText(request.error)}</p> : null}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        width={460}
        title={`Cập nhật lên ${d?.latest ?? 'bản mới'}?`}
        kicker={`Đang dùng ${d?.current ?? '—'}`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Để sau
            </Button>
            <Button variant="primary" icon="ph ph-arrow-circle-up" loading={request.isPending} onClick={() => request.mutate()}>
              Cập nhật ngay
            </Button>
          </>
        }
      >
        <ul className="upd-confirm">
          <li>Hệ thống tự sao lưu dữ liệu trước, rồi tải bản mới và khởi động lại.</li>
          <li>Mất khoảng 2–5 phút; trong lúc đó Console tạm ngắt — trang tự tải lại khi xong.</li>
          <li>Nếu có lỗi, hệ thống tự quay về bản đang dùng, dữ liệu giữ nguyên.</li>
        </ul>
        {request.isError ? <p className="upd-error">{errorText(request.error)}</p> : null}
      </Dialog>
    </Panel>
  );
}
