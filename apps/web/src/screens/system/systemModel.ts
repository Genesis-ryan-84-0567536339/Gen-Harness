/**
 * Pure presentation logic for Điều khiển hệ thống › Kênh & đăng nhập and
 * the setup channel/brain steps — ported from the design's `channels`,
 * `creds` and CLI card. Colours are token variables.
 */
import type {
  Channel,
  ChannelState,
  CliLoginStatus,
  CliProfile,
  Credential,
  GroupKind,
  ListenMode,
  ViewScope,
} from '@gen-harness/contracts';
import { countWord, fmtHM, fmtInt, fmtLatency, fmtPct, fmtRemaining, fmtSessionAge } from '../../lib/format';
import { ACC3, BAD, N3, N4, N8, OK, TXT, WARN, channelIcon, channelTone } from '../data/dataModel';

export const CHANNEL_STATE: Record<ChannelState, { label: string; tone: string }> = {
  active: { label: 'Đang kết nối', tone: OK },
  pending_qr: { label: 'Chờ quét mã', tone: WARN },
  expired: { label: 'Phiên hết hạn', tone: WARN },
  logged_out: { label: 'Chưa đăng nhập', tone: N4 },
  error: { label: 'Lỗi kết nối', tone: BAD },
  not_installed: { label: 'Chưa cài', tone: N4 },
  identity_only: { label: 'Chỉ đọc danh tính', tone: N4 },
};

export function channelState(s: ChannelState | string): { label: string; tone: string; border: string } {
  const v = CHANNEL_STATE[s as ChannelState] ?? { label: s, tone: N4 };
  return { ...v, border: v.tone === N4 ? N8 : v.tone };
}

/** Icon tile colour: the design colours the tile by channel health, not brand. */
export function channelTileTone(c: Pick<Channel, 'type' | 'state'>): string {
  if (c.state === 'active') return OK;
  if (c.state === 'expired' || c.state === 'pending_qr') return WARN;
  if (c.state === 'error') return BAD;
  if (c.state === 'not_installed' || c.state === 'identity_only' || c.state === 'logged_out') return N4;
  return channelTone(c.type);
}

export { channelIcon };

/** Channels that log in with a QR (Zalo, WhatsApp); Telegram needs its plugin, LinkedIn is identity-only. */
export const isQrChannel = (c: Pick<Channel, 'type' | 'state'>) =>
  c.state !== 'not_installed' && c.state !== 'identity_only' && (c.type === 'zalo' || c.type === 'whatsapp');

/** Meta line under the channel name — segments so "N nhóm lắng nghe" can be a button. */
export function channelMeta(c: Channel, now = Date.now(), tz?: string): { before: string; groups: string | null; after: string } {
  const groups = `${fmtInt(c.groups_listening)} nhóm lắng nghe`;
  const device = c.account_label ? `thiết bị ${c.account_label}` : '';
  switch (c.state) {
    case 'active':
      return { before: `Phiên mở ${fmtSessionAge(c.started_at, now)} · `, groups, after: device ? ` · ${device}` : '' };
    case 'expired':
    case 'error': {
      const since = c.last_heartbeat_at ? `Ngừng nhận tin từ ${fmtHM(c.last_heartbeat_at, tz)}` : 'Ngừng nhận tin';
      const queue = c.outbound_queued > 0 ? ` · ${fmtInt(c.outbound_queued)} tin trong hàng đợi gửi` : '';
      return { before: `${since}${queue} · `, groups, after: '' };
    }
    case 'pending_qr':
      return { before: 'Đang chờ quét mã trên điện thoại · ', groups, after: '' };
    case 'logged_out':
      return c.groups_listening > 0
        ? { before: 'Đã đăng xuất · ', groups, after: '' }
        : { before: 'Chưa đăng nhập — tạo mã QR để bắt đầu nhận tin', groups: null, after: '' };
    case 'not_installed':
      return { before: `Plugin @gen/channel-${c.type} có trong chợ tiện ích, chưa cài đặt`, groups: null, after: '' };
    case 'identity_only':
      return { before: 'Dùng để hợp nhất danh tính, không nhận tin nhắn', groups: null, after: '' };
    default:
      return { before: '', groups, after: '' };
  }
}

export type ChannelAction = 'logout' | 'rescan' | 'login' | 'install' | 'configure' | null;

export function channelAction(c: Pick<Channel, 'type' | 'state'>): { action: ChannelAction; label: string; icon: string; accent: boolean } {
  switch (c.state) {
    case 'active':
      return { action: 'logout', label: 'Đăng xuất', icon: 'ph ph-sign-out', accent: false };
    case 'expired':
    case 'error':
    case 'pending_qr':
      return { action: 'rescan', label: 'Quét lại QR', icon: 'ph ph-qr-code', accent: true };
    case 'logged_out':
      return { action: 'login', label: 'Tạo mã QR', icon: 'ph ph-qr-code', accent: true };
    case 'not_installed':
      return { action: 'install', label: 'Cài plugin', icon: 'ph ph-plus', accent: false };
    case 'identity_only':
      return { action: 'configure', label: 'Cấu hình', icon: 'ph ph-gear', accent: false };
    default:
      return { action: null, label: '', icon: '', accent: false };
  }
}

export interface StatCell {
  label: string;
  value: string;
  tone: string;
}

/** The four stat cells (design `ch.stats`); LinkedIn's identity counts are not in the contract → "—". */
export function channelStats(c: Channel): StatCell[] {
  const s = c.stats;
  const dash = '—';
  if (c.type === 'linkedin' || c.state === 'identity_only') {
    return [
      { label: 'Tin 24h', value: dash, tone: TXT },
      { label: 'Danh tính', value: s?.identities != null ? fmtInt(s.identities) : dash, tone: TXT },
      { label: 'Đã gộp', value: s?.merged != null ? fmtInt(s.merged) : dash, tone: TXT },
      { label: 'Thời gian trực', value: s?.uptime_pct != null ? fmtPct(s.uptime_pct) : dash, tone: TXT },
    ];
  }
  const degraded = c.state === 'expired' || c.state === 'error';
  const up = s?.uptime_pct;
  return [
    { label: 'Tin 24h', value: s?.msgs_24h != null ? fmtInt(s.msgs_24h) : dash, tone: degraded && s?.msgs_24h != null ? WARN : TXT },
    { label: 'Được tag', value: s?.tagged_24h != null ? fmtInt(s.tagged_24h) : dash, tone: TXT },
    { label: 'Độ trễ', value: s?.latency_ms != null ? fmtLatency(s.latency_ms) : dash, tone: TXT },
    { label: 'Thời gian trực', value: up != null ? fmtPct(up) : dash, tone: up == null ? TXT : up >= 99 ? OK : up >= 95 ? TXT : WARN },
  ];
}

// ── QR ────────────────────────────────────────────────────────────────────
export const QR_LIFETIME_MS = 60_000;

export function qrRemaining(expiresAt: string, now = Date.now()): { ms: number; pct: number; label: string } {
  const ms = Math.max(0, new Date(expiresAt).getTime() - now);
  const s = Math.min(QR_LIFETIME_MS / 1000, Math.ceil(ms / 1000));
  return { ms, pct: Math.min(100, (ms / QR_LIFETIME_MS) * 100), label: `${s} giây` };
}

export function qrHint(c: Pick<Channel, 'outbound_queued'>): string {
  const queued =
    c.outbound_queued > 0
      ? ` ${countWord(c.outbound_queued)} tin gửi đi đang được giữ trong hàng đợi, sẽ tự gửi khi phiên nối lại.`
      : '';
  return `Mã tự làm mới mỗi 60 giây.${queued}`;
}

// ── groups ────────────────────────────────────────────────────────────────
export const LISTEN_MODES: Array<{ value: ListenMode; label: string }> = [
  { value: 'off', label: 'Không nghe' },
  { value: 'tagged_only', label: 'Chỉ khi được tag' },
  { value: 'silent', label: 'Lắng nghe im lặng' },
  { value: 'proactive', label: 'Chủ động bắt tín hiệu' },
  { value: 'paused', label: 'Tạm dừng' },
];

export const VIEW_SCOPES: Array<{ value: ViewScope; label: string }> = [
  { value: 'owner', label: 'Chỉ Sếp' },
  { value: 'manager', label: 'Sếp + quản lý' },
  { value: 'all_members', label: 'Mọi thành viên' },
];

export const GROUP_KIND_LABEL: Record<GroupKind, string> = {
  internal: 'Nội bộ',
  market: 'Thị trường',
  partner: 'Đối tác',
  customer: 'Khách hàng',
  private: 'Riêng tư',
};

export const groupKindLabel = (k: string) => GROUP_KIND_LABEL[k as GroupKind] ?? k;

export function listenTone(m: ListenMode | string): string {
  return m === 'off' ? N4 : m === 'paused' ? WARN : m === 'proactive' ? ACC3 : OK;
}

// ── credentials & CLI ─────────────────────────────────────────────────────
export function credTone(s: Credential['state'] | string): string {
  return s === 'ok' ? OK : s === 'warn' ? WARN : s === 'bad' ? BAD : N4;
}

export function cliChip(active: CliProfile | undefined): { label: string; tone: string } {
  if (!active) return { label: 'Chưa đăng nhập', tone: N4 };
  if (active.state === 'expired') return { label: 'Hết hạn', tone: BAD };
  if (active.state === 'expiring') return { label: 'Sắp hết hạn', tone: WARN };
  return { label: 'Đã xác thực', tone: OK };
}

/** "Google AI Pro · token 0 ₫ · còn hiệu lực 23 giờ" — plan_label carries the plan/token part. */
export function cliMeta(p: CliProfile, now = Date.now()): string {
  const left = p.expires_at ? (fmtRemaining(p.expires_at, now) === 'đã hết' ? 'đã hết hiệu lực' : `còn hiệu lực ${fmtRemaining(p.expires_at, now)}`) : null;
  return [p.plan_label, left].filter(Boolean).join(' · ') || '—';
}

export const CLI_LOGIN_TEXT: Record<CliLoginStatus, string> = {
  starting: 'Đang mở phiên đăng nhập của CLI…',
  waiting_code: 'Mở trang đăng nhập, đăng nhập Google rồi dán mã xác thực vào đây.',
  verifying: 'Đang xác thực mã…',
  done: 'Đã đăng nhập.',
  failed: 'Đăng nhập không thành công.',
};

export { N3 };
