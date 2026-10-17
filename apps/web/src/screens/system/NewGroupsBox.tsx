import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, type Channel, type ChannelGroup, type SettableListenMode } from '@gen-harness/contracts';
import { Button, Icon } from '@gen-harness/ui';
import { api } from '../../lib/api';
import { qk2, usePendingGroups } from '../../lib/dataQueries';
import { errorText } from '../../lib/errorText';
import { fmtInt } from '../../lib/format';
import { queryClient } from '../../lib/queryClient';
import { toast } from '../../lib/toast';
import { ErrorWithDetail } from '../../social/WriteProofDialog';
import { BRIDGE_OFFLINE_TEXT, BRIDGE_OFFLINE_TITLE, isQrChannel } from './systemModel';

/** Tối đa bấy nhiêu nhóm hiện thẳng trong thẻ; còn lại mở bảng nhóm đầy đủ. */
const SHOW_MAX = 4;

/** Hai lựa chọn của nhóm mới (v0.1.65, quyết định Sếp): Im lặng = lưu tin, không trả lời · Không nghe = không lưu. */
const CHOICES: Array<{ mode: SettableListenMode; label: string; icon: string }> = [
  { mode: 'silent', label: 'Im lặng', icon: 'ph ph-eye' },
  { mode: 'off', label: 'Không nghe', icon: 'ph ph-bell-slash' },
];

/**
 * Hộp "Nhóm mới — chọn Im lặng/Không nghe": hiện trên thẻ kênh khi có nhóm CHỜ chọn (`listen_mode = pending`) — ngay sau
 * khi nối kênh (bridge đồng bộ danh sách nhóm) và mỗi khi bridge phát hiện nhóm mới. Chưa chọn thì Gen không lưu tin nào
 * của nhóm đó; dù chọn gì, danh sách thành viên vẫn được ghi nhận (để hợp nhất danh tính, không lưu tin).
 */
export function NewGroupsBox({ channel, canManage, onOpenAll }: { channel: Channel; canManage: boolean; onOpenAll: () => void }) {
  const enabled = isQrChannel(channel) && channel.installed && channel.state === 'active' && (channel.groups_pending ?? 1) > 0;
  const pending = usePendingGroups(channel.type, enabled);
  const [failed, setFailed] = useState<unknown>(null);

  const choose = useMutation({
    mutationFn: async ({ ids, mode }: { ids: string[]; mode: SettableListenMode }) => {
      for (const id of ids) await api.channels.setGroupMode(channel.type, id, mode);
      return ids.length;
    },
    onMutate: () => setFailed(null),
    onSuccess: (n, v) => {
      toast(`${n === 1 ? 'Đã chọn' : `Đã chọn cho ${fmtInt(n)} nhóm`}: ${v.mode === 'silent' ? 'Im lặng — lưu tin, không tự trả lời' : 'Không nghe — không lưu tin'}`, 'neutral');
    },
    onError: (e) => setFailed(e),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk2.channelGroups(channel.type) });
      void queryClient.invalidateQueries({ queryKey: qk2.channels });
      void queryClient.invalidateQueries({ queryKey: qk2.pipeline });
    },
  });

  // Phòng thủ: máy chủ lạ/cũ trả không phải mảng thì coi như không có nhóm chờ (không làm sập thẻ kênh).
  const rows: ChannelGroup[] = enabled && Array.isArray(pending.data) ? pending.data : [];
  if (rows.length === 0) return null;
  const shown = rows.slice(0, SHOW_MAX);
  const more = rows.length - shown.length;
  const busy = choose.isPending;
  return (
    <section className="ch-newgroups" aria-label={`Nhóm mới của ${channel.name} đang chờ chọn`} data-testid={`newgroups-${channel.type}`}>
      <div className="ch-newgroups__head">
        <Icon name="ph ph-users-three" size={16} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ch-alert__title">
            Nhóm mới — chọn Im lặng hay Không nghe ({fmtInt(rows.length)})
          </div>
          <div className="ch-alert__text">
            Gen chưa lưu tin nào của các nhóm này cho tới khi Sếp chọn. <b>Im lặng</b>: lưu tin, không tự trả lời. <b>Không nghe</b>: không lưu tin.
            Dù chọn gì, danh sách thành viên vẫn được ghi nhận để hợp nhất danh tính.
          </div>
        </div>
      </div>
      <ul className="ch-newgroups__list">
        {shown.map((g) => (
          <li key={g.id} className="ch-newgroups__row">
            <span className="ch-newgroups__name">
              {g.name}
              <span className="ch-newgroups__count">{fmtInt(g.members)} thành viên</span>
            </span>
            {canManage ? (
              <span className="ch-newgroups__btns">
                {CHOICES.map((c) => (
                  <Button
                    key={c.mode}
                    variant="secondary"
                    size="sm"
                    icon={c.icon}
                    disabled={busy}
                    aria-label={`${c.label} — nhóm ${g.name}`}
                    onClick={() => choose.mutate({ ids: [g.id], mode: c.mode })}
                  >
                    {c.label}
                  </Button>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {more > 0 || (canManage && rows.length > 1) ? (
        <div className="ch-newgroups__foot">
          {more > 0 ? (
            <Button variant="ghost" size="sm" onClick={onOpenAll}>
              Xem cả {fmtInt(rows.length)} nhóm
            </Button>
          ) : null}
          {canManage && rows.length > 1 ? (
            <span className="ch-newgroups__btns">
              {CHOICES.map((c) => (
                <Button
                  key={c.mode}
                  variant="secondary"
                  size="sm"
                  icon={c.icon}
                  disabled={busy}
                  loading={busy && choose.variables?.mode === c.mode && choose.variables.ids.length > 1}
                  onClick={() => choose.mutate({ ids: rows.map((g) => g.id), mode: c.mode })}
                >
                  Tất cả {fmtInt(rows.length)} nhóm: {c.label}
                </Button>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
      {failed ? <ErrorWithDetail className="write-error" error={failed} /> : null}
    </section>
  );
}

/** Tin nhắn thân thiện khi bấm "Cập nhật danh sách nhóm" không được (kèm "Chi tiết kỹ thuật" ở chỗ hiển thị). */
function refreshErrorText(e: unknown): string {
  if (e instanceof ApiError && e.code === 'BRIDGE_OFFLINE') return `${BRIDGE_OFFLINE_TITLE}. ${BRIDGE_OFFLINE_TEXT}`;
  return errorText(e);
}

/**
 * "Cập nhật danh sách nhóm" (F056): bảo bộ nhận tin quét lại ngay thay vì chờ chu kỳ — nhóm vừa vào hiện sau vài giây.
 * Lỗi hiện ngay dưới nút bằng câu thân thiện + "Chi tiết kỹ thuật", không phải toast mất đi.
 */
export function RefreshGroupsButton({ channel, size = 'sm' }: { channel: Pick<Channel, 'type' | 'name'>; size?: 'sm' | 'md' }) {
  const [error, setError] = useState<unknown>(null);
  const refresh = useMutation({
    mutationFn: () => api.channels.refreshGroups(channel.type),
    onMutate: () => setError(null),
    onSuccess: () => {
      toast(`Đang cập nhật danh sách nhóm ${channel.name} — vài giây nữa nhóm mới sẽ hiện`, 'neutral');
      // Bridge quét xong mới đẩy danh bạ; tải lại sau vài nhịp để Sếp thấy kết quả mà không cần bấm thêm.
      for (const ms of [4000, 12000]) {
        setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: qk2.channelGroups(channel.type) });
          void queryClient.invalidateQueries({ queryKey: qk2.channels });
        }, ms);
      }
    },
    onError: (e) => setError(e),
  });
  return (
    <>
      <Button
        variant="secondary"
        size={size}
        icon="ph ph-arrows-clockwise"
        loading={refresh.isPending}
        onClick={() => refresh.mutate()}
        data-testid={`refresh-groups-${channel.type}`}
      >
        Cập nhật danh sách nhóm
      </Button>
      {error ? <ErrorWithDetail className="write-error" text={refreshErrorText(error)} error={error} /> : null}
    </>
  );
}
