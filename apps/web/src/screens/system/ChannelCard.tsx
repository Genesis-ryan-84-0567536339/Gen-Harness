import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, type Channel, type ChannelGroup, type ListenMode, type ViewScope } from '@gen-harness/contracts';
import { Button, Dialog, EmptyState, Icon, Switch, TextField } from '@gen-harness/ui';
import { api } from '../../lib/api';
import { qk2, useChannelGroups } from '../../lib/dataQueries';
import { fmtInt } from '../../lib/format';
import { useCan, useOrgTimezone } from '../../lib/permissions';
import { queryClient } from '../../lib/queryClient';
import { toast } from '../../lib/toast';
import { useNow } from '../../lib/useNow';
import { errorDetail, errorText } from '../../lib/errorText';
import { ErrorWithDetail } from '../../social/WriteProofDialog';
import { Bar, CardError, InlineError, SkeletonLines } from '../common';
import { ConnectionStatusPill } from '../connections/ConnectionStatusPill';
import { useSystemHealth } from './queries';
import { channelConnStatus } from '../connections/connectionsModel';
import {
  BRIDGE_OFFLINE_TEXT,
  BRIDGE_OFFLINE_TITLE,
  LISTEN_MODES,
  VIEW_SCOPES,
  channelAction,
  channelErrorText,
  channelIcon,
  channelMeta,
  channelSecondaryAction,
  channelStats,
  channelStatus,
  channelTileTone,
  groupKindLabel,
  isBridgeLost,
  isDenseQr,
  isQrChannel,
  qrHint,
  qrLifetimeMs,
  qrRemaining,
  withBridgeHealth,
} from './systemModel';

/**
 * One channel card (design `channels`). Logging in always goes through the
 * risk warning first: the QR never appears before `accept_risk: true` is sent.
 */
export function ChannelCard({ channel, canManage, large }: { channel: Channel; canManage: boolean; large?: boolean }) {
  // v0.1.62 (F051): bộ nhận tin im theo /system/health (vai có system.read) ⇒ "Mất liên lạc" thay "Đang kết nối".
  const health = useSystemHealth(useCan('system.read'));
  const c = withBridgeHealth(channel, health.data?.bridge?.state === 'silent');
  const tz = useOrgTimezone();
  const now = useNow(30_000);
  const st = channelStatus(c);
  const lost = isBridgeLost(c);
  const meta = channelMeta(c, now, tz);
  const act = channelAction(c);
  const second = channelSecondaryAction(c);
  const [riskOpen, setRiskOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  /** Set after the login request is accepted, until the first `channel.qr` arrives. */
  const [awaitingQr, setAwaitingQr] = useState(false);
  /** 503 BRIDGE_OFFLINE on login/resume: shown in the card (not a toast) with a retry. Giữ lỗi gốc để có "Chi tiết kỹ thuật". */
  const [bridgeDown, setBridgeDown] = useState<unknown>(null);
  const [lastLabel, setLastLabel] = useState('');

  const login = useMutation({
    mutationFn: (accountLabel: string) =>
      api.channels.login(c.type, { accept_risk: true, ...(accountLabel ? { account_label: accountLabel } : {}) }),
    onMutate: (accountLabel) => {
      setLastLabel(accountLabel);
      setBridgeDown(null);
      setAwaitingQr(true);
    },
    onError: (e) => {
      setAwaitingQr(false);
      if (e instanceof ApiError && e.code === 'BRIDGE_OFFLINE') setBridgeDown(e);
      else toast(errorText(e), 'bad');
    },
  });
  /** v0.1.62 (F046): nối lại bằng phiên đã lưu — không quét QR, không cần hộp cảnh báo rủi ro (đã chấp nhận lần đăng nhập đầu). */
  const resume = useMutation({
    mutationFn: () => api.channels.resume(c.type),
    onMutate: () => setBridgeDown(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk2.channels });
      toast(`Đang nối lại ${c.name} bằng phiên đã lưu — không cần quét QR`, 'neutral');
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'BRIDGE_OFFLINE') setBridgeDown(e);
      else toast(errorText(e), 'bad');
    },
  });
  useEffect(() => {
    if (c.qr || c.state === 'active') setAwaitingQr(false);
  }, [c.qr, c.state]);

  const logout = useMutation({
    mutationFn: () => api.channels.logout(c.type),
    onSuccess: () => {
      queryClient.setQueryData<Channel[]>(qk2.channels, (old) =>
        old?.map((x) => (x.type === c.type ? { ...x, state: 'logged_out', qr: null } : x)),
      );
      void queryClient.invalidateQueries({ queryKey: qk2.channels });
      void queryClient.invalidateQueries({ queryKey: qk2.credentials });
      toast(`Đã đăng xuất ${c.name}`, 'neutral');
    },
    onError: (e) => toast(errorText(e), 'bad'),
  });

  const showQr = isQrChannel(c) && (!!c.qr || awaitingQr);

  let button = null;
  if (act.action === 'unavailable') {
    // v0.1.42 (F-41): Plugin đóng băng — không còn dẫn tới /plugins; kênh này chưa có trong bản đang chạy.
    button = (
      <span className="ch-note" data-main-action>
        <Icon name={act.icon} size={13} />
        {act.label}
      </span>
    );
  } else if (act.action && canManage) {
    const onClick =
      act.action === 'logout'
        ? () => setLogoutOpen(true)
        : act.action === 'configure'
          ? () => setGroupsOpen(true)
          : act.action === 'resume'
            ? () => resume.mutate()
            : () => setRiskOpen(true);
    button = (
      <>
        {second ? (
          <Button variant="secondary" className="ch-btn" icon={second.icon} loading={login.isPending} onClick={() => setRiskOpen(true)}>
            {second.label}
          </Button>
        ) : null}
        <Button
          data-main-action
          variant={act.accent ? 'primary' : 'secondary'}
          className="ch-btn"
          icon={act.icon}
          loading={
            (act.action === 'logout' && logout.isPending) ||
            (act.action === 'resume' && resume.isPending) ||
            (act.accent && act.action !== 'resume' && login.isPending)
          }
          onClick={onClick}
        >
          {act.label}
        </Button>
      </>
    );
  }

  return (
    <article className="ch-card" aria-label={`Kênh ${c.name}`}>
      <div className="ch-head">
        <div className="ch-tile" style={{ color: channelTileTone(c) }}>
          <Icon name={channelIcon(c.type)} size={17} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ch-titleline">
            <span className="ch-name">{c.name}</span>
            {/* v0.1.42 (F-7): một kiểu viên trạng thái cho mọi thẻ Kết nối; chữ chi tiết chuyển xuống dòng meta. */}
            <ConnectionStatusPill status={channelConnStatus(lost ? { state: 'error' } : c)} />
          </div>
          <div className="ch-meta">
            <span className="ch-meta__state" style={{ color: st.tone }}>
              {st.label}
            </span>
            {meta.before || meta.groups ? ' · ' : null}
            {meta.before}
            {meta.groups ? (
              // A span (not <button>) so the text wraps inside the sentence exactly like the design.
              <span
                role="button"
                tabIndex={0}
                className="ch-meta__link"
                onClick={() => setGroupsOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setGroupsOpen(true);
                  }
                }}
                aria-label={`${meta.groups} — xem và chỉnh nhóm ${c.name}`}
              >
                {meta.groups}
              </span>
            ) : null}
            {meta.after}
          </div>
        </div>
        {button}
      </div>

      {bridgeDown && !showQr ? (
        <div className="ch-alert" role="alert">
          <Icon name="ph ph-plugs" size={16} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ch-alert__title">{BRIDGE_OFFLINE_TITLE}</div>
            <div className="ch-alert__text">{BRIDGE_OFFLINE_TEXT}</div>
            {errorDetail(bridgeDown) ? (
              <details className="write-error__detail">
                <summary>Chi tiết kỹ thuật</summary>
                <code>{errorDetail(bridgeDown)}</code>
              </details>
            ) : null}
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon="ph ph-arrow-clockwise"
            loading={login.isPending || resume.isPending}
            onClick={() => (act.action === 'resume' ? resume.mutate() : login.mutate(lastLabel))}
          >
            Thử lại
          </Button>
        </div>
      ) : null}

      {lost && !bridgeDown && !showQr ? (
        <div className="ch-alert" role="alert" data-testid={`lost-${c.type}`}>
          <Icon name="ph ph-plugs" size={16} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ch-alert__title">Mất liên lạc với bộ nhận tin Zalo/WhatsApp</div>
            <div className="ch-alert__text">
              Bộ nhận tin không còn báo nhịp tim nên tin của khách có thể đang không về. Thử lại sau ít phút; nếu vẫn lỗi, gửi Gói chẩn đoán cho người hỗ trợ.
            </div>
          </div>
        </div>
      ) : null}

      {showQr ? <QrBlock channel={c} large={large} /> : null}

      {!showQr && (c.state === 'expired' || c.state === 'error') && c.error ? (
        <ErrorWithDetail className="write-error ch-fail" text={channelErrorText(c.error, c.name, c.type, !!c.resumable)} detail={c.error} />
      ) : null}

      <div className="ch-stats">
        {channelStats(c).map((s) => (
          <div className="ch-stat" key={s.label}>
            <div className="ch-stat__label">{s.label}</div>
            <div className="ch-stat__value" style={{ color: s.tone }}>
              {s.value}
            </div>
          </div>
        ))}
      </div>

      <RiskWarningDialog
        open={riskOpen}
        channel={c}
        onClose={() => setRiskOpen(false)}
        onAccept={(label) => {
          setRiskOpen(false);
          login.mutate(label);
        }}
      />
      <Dialog
        open={logoutOpen}
        onClose={() => setLogoutOpen(false)}
        width={400}
        title={`Đăng xuất ${c.name}?`}
        kicker="Cần mã PIN"
        actions={
          <>
            <Button variant="secondary" onClick={() => setLogoutOpen(false)}>
              Huỷ
            </Button>
            <Button
              variant="primary"
              icon="ph ph-sign-out"
              onClick={() => {
                setLogoutOpen(false);
                logout.mutate();
              }}
            >
              Đăng xuất
            </Button>
          </>
        }
      >
        <p className="risk-box__text">
          Gen ngừng nhận tin từ {fmtInt(c.groups_listening)} nhóm cho tới khi Sếp quét mã QR lại. Tin Sếp soạn gửi đi trong lúc chưa đăng
          nhập sẽ bị từ chối, không được giữ lại để tự gửi sau.
        </p>
      </Dialog>
      <GroupsDialog open={groupsOpen} onClose={() => setGroupsOpen(false)} channel={c} canManage={canManage} />
    </article>
  );
}

/**
 * QR block with the countdown. Zalo's code is sparse (~30 modules): 88px on the Console, 240px in setup. WhatsApp's is
 * dense (~60 modules) and hard to read when small, so it is always drawn large (`qr-block--dense`: up to 320px, shrinking
 * only with the card's width).
 */
export function QrBlock({ channel: c, large }: { channel: Channel; large?: boolean }) {
  const now = useNow(1000, !!c.qr);
  const qr = c.qr;
  const left = qr ? qrRemaining(qr.expires_at, now, qrLifetimeMs(c.type)) : null;
  const expired = !!left && left.ms <= 0;
  const dense = isDenseQr(c);
  return (
    <div
      className={['qr-block', large || dense ? 'qr-block--lg' : '', dense ? 'qr-block--dense' : ''].filter(Boolean).join(' ')}
      data-testid={`qr-${c.type}`}
    >
      <div className="qr-img">
        {qr && !expired ? (
          <img src={qr.image} alt={`Mã QR đăng nhập ${c.name}. Mở ${c.name} trên điện thoại, vào Cài đặt › Thiết bị đã liên kết rồi quét mã này.`} />
        ) : (
          <Icon name={qr ? 'ph ph-arrows-clockwise' : 'ph ph-qr-code'} size={large ? 64 : 42} />
        )}
      </div>
      <div style={{ flex: dense ? '1 1 200px' : 1, minWidth: 0 }}>
        <div className="qr-title">
          {qr?.scanned ? 'Đã quét — đang đồng bộ danh sách nhóm…' : qr ? `Quét mã bằng ${c.name} trên điện thoại của Sếp` : 'Đang tạo mã QR…'}
        </div>
        <div className="qr-text">
          {qr
            ? qrHint(c)
            : 'Gen đang mở phiên đăng nhập mới. Mã sẽ hiện ở đây sau vài giây.'}
        </div>
        {large || dense ? (
          <ol className="qr-steps">
            <li data-done={qr ? '' : undefined} data-on={!qr ? '' : undefined}>Tạo mã QR</li>
            <li data-done={qr?.scanned ? '' : undefined} data-on={qr && !qr.scanned ? '' : undefined}>
              Mở {c.name} trên điện thoại › Thiết bị đã liên kết › quét mã
            </li>
            <li data-on={qr?.scanned ? '' : undefined}>Đồng bộ danh sách nhóm</li>
          </ol>
        ) : null}
        {qr && left && !qr.scanned ? (
          <div className="qr-count">
            <Bar pct={left.pct} tone="var(--color-warn)" height={4} />
            <span className="qr-count__val" aria-live="polite" aria-atomic="true">
              {expired ? 'đang làm mới…' : left.label}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** "Cảnh báo rủi ro tài khoản cá nhân trước khi hiện QR" (docs/06 bước 5). */
export function RiskWarningDialog({
  open,
  channel,
  onClose,
  onAccept,
}: {
  open: boolean;
  channel: Pick<Channel, 'name' | 'account_label'>;
  onClose: () => void;
  onAccept: (accountLabel: string) => void;
}) {
  const [ack, setAck] = useState(false);
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (open) {
      setAck(false);
      setLabel(channel.account_label ?? '');
    }
  }, [open, channel.account_label]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={460}
      title="Trước khi hiện mã QR"
      kicker={`Đăng nhập ${channel.name} bằng tài khoản cá nhân`}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="primary" icon="ph ph-qr-code" disabled={!ack} onClick={() => onAccept(label.trim())}>
            Tôi hiểu, hiện mã QR
          </Button>
        </>
      }
    >
      <div className="dlg-fields">
        <div className="risk-box" role="note">
          <Icon name="ph ph-warning" size={16} color="var(--color-warn)" />
          <div className="risk-box__text">
            Gen-Harness kết nối {channel.name} như một thiết bị đăng nhập của chính Sếp, không qua cổng chính thức cho doanh nghiệp.{' '}
            {channel.name} có thể tạm khoá hoặc hạn chế tài khoản nếu thấy hoạt động bất thường.
          </div>
        </div>
        <ul className="risk-list">
          <li>Dùng tài khoản Sếp sở hữu, không dùng tài khoản của nhân viên hay khách.</li>
          <li>Gen chỉ nghe nhóm Sếp bật — nhóm mới luôn ở chế độ Không nghe.</li>
          <li>Tin gửi đi phải qua duyệt và ranh giới tự trị, không gửi hàng loạt.</li>
          <li>Đăng xuất bất cứ lúc nào ở đây hoặc trong ứng dụng trên điện thoại.</li>
        </ul>
        <TextField
          label="Tên thiết bị (tuỳ chọn)"
          placeholder="Ví dụ: iPhone của Sếp"
          value={label}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
        />
        <label className="gh-check">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-autofocus />
          <span>Tôi hiểu rủi ro và đăng nhập bằng tài khoản của chính mình.</span>
        </label>
      </div>
    </Dialog>
  );
}

/** Nhóm của một kênh: chế độ lắng nghe + phạm vi xem (PATCH /groups/{id}, system.manage). */
export function GroupsDialog({
  open,
  onClose,
  channel,
  canManage,
}: {
  open: boolean;
  onClose: () => void;
  channel: Channel;
  canManage: boolean;
}) {
  const c = channel;
  const groups = useChannelGroups(channel.type, open);
  const direct = useMutation({
    mutationFn: (v: boolean) => api.channels.update(c.type, { listen_direct: v }),
    onMutate: (v) => {
      queryClient.setQueryData<Channel[]>(qk2.channels, (old) => old?.map((x) => (x.type === c.type ? { ...x, listen_direct: v } : x)));
    },
    onSuccess: (next) => {
      queryClient.setQueryData<Channel[]>(qk2.channels, (old) => old?.map((x) => (x.type === c.type ? next : x)));
      toast(next.listen_direct ? `${c.name}: đang nghe cả tin nhắn 1-1` : `${c.name}: không nghe tin nhắn 1-1`, 'neutral');
    },
    onError: (e) => {
      void queryClient.invalidateQueries({ queryKey: qk2.channels });
      toast(errorText(e), 'bad');
    },
  });
  const showDirect = isQrChannel(c) && c.installed && typeof c.listen_direct === 'boolean';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={720}
      padded={false}
      title={`Nhóm ${channel.name}`}
      kicker="Nhóm mới luôn ở chế độ Không nghe — Sếp bật từng nhóm"
    >
      {showDirect ? (
        <div className="ch-direct">
          <span className="ch-direct__label">
            Nghe tin nhắn 1-1
            <span className="ch-direct__hint">
              {c.listen_direct ? 'Đang bật — tin nhắn riêng gửi tới tài khoản cũng vào kho thô.' : 'Mặc định tắt — chỉ nghe nhóm. Đổi cần mã PIN.'}
            </span>
          </span>
          <Switch
            checked={!!c.listen_direct}
            label={`${c.listen_direct ? 'Tắt' : 'Bật'} nghe tin nhắn 1-1 trên ${c.name}`}
            disabled={!canManage || direct.isPending}
            onChange={(v) => direct.mutate(v)}
          />
        </div>
      ) : null}
      {groups.isPending ? (
        <SkeletonLines rows={4} />
      ) : groups.isError ? (
        <CardError error={groups.error} onRetry={() => void groups.refetch()} retrying={groups.isFetching} />
      ) : groups.data.length === 0 ? (
        <EmptyState
          icon="ph ph-users-three"
          title="Chưa có nhóm nào"
          description={channel.type === 'linkedin' ? 'LinkedIn chỉ dùng để hợp nhất danh tính, không có nhóm lắng nghe.' : 'Danh sách nhóm đồng bộ sau khi kênh đăng nhập.'}
        />
      ) : (
        <div className="gh-table-scroll" style={{ maxHeight: '60vh' }}>
          <GroupsTable groups={groups.data} type={channel.type} canManage={canManage} />
        </div>
      )}
    </Dialog>
  );
}

export function GroupsTable({
  groups,
  type,
  canManage,
  onLocalChange,
}: {
  groups: ChannelGroup[];
  type: string;
  canManage: boolean;
  /** Setup step 6 collects changes locally instead of PATCHing each row. */
  onLocalChange?: (id: string, patch: { listen_mode?: ListenMode; view_scope?: ViewScope }) => void;
}) {
  return (
    <table className="gh-table grp-table" aria-label="Nhóm theo kênh">
      <thead>
        <tr>
          <th>Nhóm</th>
          <th style={{ width: 90 }}>Loại</th>
          <th style={{ width: 80 }}>Thành viên</th>
          <th style={{ width: 170 }}>Chế độ lắng nghe</th>
          <th style={{ width: 140 }}>Phạm vi xem</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <GroupRow key={g.id} g={g} type={type} canManage={canManage} onLocalChange={onLocalChange} />
        ))}
      </tbody>
    </table>
  );
}

function GroupRow({
  g,
  type,
  canManage,
  onLocalChange,
}: {
  g: ChannelGroup;
  type: string;
  canManage: boolean;
  onLocalChange?: (id: string, patch: { listen_mode?: ListenMode; view_scope?: ViewScope }) => void;
}) {
  const save = useMutation({
    mutationFn: (patch: { listen_mode?: ListenMode; view_scope?: ViewScope }) => api.groups.update(g.id, patch),
    onMutate: async (patch) => {
      const key = qk2.channelGroups(type);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<ChannelGroup[]>(key);
      queryClient.setQueryData<ChannelGroup[]>(key, (old) => old?.map((x) => (x.id === g.id ? { ...x, ...patch } : x)));
      return { prev };
    },
    onError: (e, _p, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(qk2.channelGroups(type), ctx.prev);
      toast(errorText(e), 'bad');
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<ChannelGroup[]>(qk2.channelGroups(type), (old) => old?.map((x) => (x.id === saved.id ? saved : x)));
      void queryClient.invalidateQueries({ queryKey: qk2.channels });
      void queryClient.invalidateQueries({ queryKey: qk2.pipeline });
    },
  });
  const change = (patch: { listen_mode?: ListenMode; view_scope?: ViewScope }) =>
    onLocalChange ? onLocalChange(g.id, patch) : save.mutate(patch);
  return (
    <tr>
      <td>
        <div className="grp-name">{g.name}</div>
        <div className="grp-code">{g.code}</div>
      </td>
      <td style={{ fontSize: 11, color: 'var(--color-neutral-400)' }}>{groupKindLabel(g.kind)}</td>
      <td className="td-id">{fmtInt(g.members)}</td>
      <td>
        <select
          className="mini-select"
          aria-label={`Chế độ lắng nghe của ${g.name}`}
          value={g.listen_mode}
          disabled={!canManage}
          onChange={(e) => change({ listen_mode: e.target.value as ListenMode })}
        >
          {LISTEN_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </td>
      <td>
        <select
          className="mini-select"
          aria-label={`Phạm vi xem của ${g.name}`}
          value={g.view_scope}
          disabled={!canManage}
          onChange={(e) => change({ view_scope: e.target.value as ViewScope })}
        >
          {VIEW_SCOPES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        {save.isError ? <InlineError>{errorText(save.error)}</InlineError> : null}
      </td>
    </tr>
  );
}
