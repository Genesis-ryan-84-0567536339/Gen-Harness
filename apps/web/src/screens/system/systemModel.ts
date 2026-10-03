/**
 * Pure presentation logic for Điều khiển hệ thống › Kênh & đăng nhập and
 * the setup channel/brain steps — ported from the design's `channels`,
 * `creds` and CLI card. Colours are token variables.
 */
import type {
  Boundary,
  Channel,
  ChannelState,
  CliKind,
  CliLoginStatus,
  CliProfile,
  Credential,
  GroupKind,
  ListenMode,
  PermScope,
  RetentionPolicy,
  ViewScope,
} from '@gen-harness/contracts';
import { ALL_ONLY_PERMS, ApiError, PinCancelledError } from '@gen-harness/contracts';
import { DEFAULT_TZ, countWord, fmtDM, fmtHM, fmtInt, fmtLatency, fmtPct, fmtRemaining, fmtSessionAge } from '../../lib/format';
import { ACC3, BAD, N3, N4, N5, N8, OK, TXT, WARN, channelIcon, channelTone } from '../data/dataModel';

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

/** Channels that log in with a QR (Zalo, WhatsApp); Telegram is not in this build, LinkedIn is identity-only. */
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
      // v0.1.42 (F-41): Plugin đóng băng — không còn trỏ tới chợ tiện ích.
      return { before: 'Kênh này chưa có trong bản đang chạy', groups: null, after: '' };
    case 'identity_only':
      return { before: 'Dùng để hợp nhất danh tính, không nhận tin nhắn', groups: null, after: '' };
    default:
      return { before: '', groups, after: '' };
  }
}

export type ChannelAction = 'logout' | 'rescan' | 'login' | 'unavailable' | 'configure' | null;

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
      return { action: 'unavailable', label: 'Chưa có trong bản này', icon: 'ph ph-info', accent: false };
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

/**
 * v0.1.31 (Boss 01/10): MỘT sự thật với dòng nguồn — máy chủ tính `state` từ hạn token + refresh token + lượt gọi thật
 * gần nhất. "ok" = AI gọi được (kể cả khi token ngắn hạn đã quá giờ nhưng CLI tự gia hạn) → "Đang hoạt động".
 */
export function cliChip(active: CliProfile | undefined): { label: string; tone: string } {
  if (!active) return { label: 'Chưa đăng nhập', tone: N4 };
  if (active.state === 'expired') return { label: 'Hết hạn', tone: BAD };
  if (active.state === 'expiring') return { label: 'Sắp hết hạn', tone: WARN };
  return { label: 'Đang hoạt động', tone: OK };
}

/**
 * v0.1.38 (F-22): luật cứng — model của Antigravity CLI chỉ dùng cho Gen của Sếp (API từ chối gán cho khoá khác
 * `core.gen`, mã 409 AGY_OWNER_GEN_ONLY). Câu dùng chung cho thẻ CLI, bước thiết lập và ô chọn model.
 */
export const AGY_SCOPE_TEXT =
  'Chỉ dùng cho Gen — trợ lý quản trị (Gen của Sếp). Sàng lọc tin và trực việc phải dùng nguồn khác (khoá API hoặc Claude Code CLI) — luật an toàn, không tắt được.';

/** v0.1.31: chữ theo loại CLI — Antigravity (tài khoản Google) hay Claude Code (gói Claude Pro/Max). */
export const CLI_TEXT: Record<CliKind, { title: string; kicker: string; account: string; login: string; add: string; empty: string; openLink: string; hint: string; scope: string | null }> = {
  antigravity_cli: {
    title: 'Tài khoản Antigravity CLI',
    kicker: 'Tài khoản Google dùng cho AI',
    account: 'Google',
    login: 'Đăng nhập',
    add: 'Thêm tài khoản Google',
    empty: 'Đăng nhập Google để hệ thống dùng AI qua Antigravity CLI',
    openLink: 'Mở trang đăng nhập Google',
    hint: 'Đăng nhập đúng tài khoản Google muốn dùng; trang Google sẽ hiện một mã — chép mã đó dán vào ô bên dưới.',
    scope: AGY_SCOPE_TEXT,
  },
  claude_code_cli: {
    title: 'Tài khoản Claude Code CLI',
    kicker: 'Gói Claude Pro/Max của Sếp · tuỳ chọn',
    account: 'Claude',
    login: 'Đăng nhập Claude',
    add: 'Thêm tài khoản Claude',
    empty: 'Chưa bật — đăng nhập gói Claude (Pro/Max) nếu Sếp muốn AI dùng thêm model Claude',
    openLink: 'Mở trang đăng nhập Claude',
    hint: 'Đăng nhập đúng tài khoản Claude muốn dùng, bấm cho phép; trang sẽ hiện một mã — chép mã đó dán vào ô bên dưới.',
    scope: null,
  },
};

/** Trang điều khoản chính thức (QD-12: Owner tự quyết) — Anthropic: đăng nhập gói Free/Pro/Max chỉ cho dùng cá nhân thông thường. */
export const CLAUDE_TERMS_URL = 'https://code.claude.com/docs/en/legal-and-compliance';
export const CLAUDE_CONSUMER_TERMS_URL = 'https://www.anthropic.com/legal/consumer-terms';

/** Email of a CLI profile, or a readable stand-in when the session file did not reveal it (email null). */
export function cliAccountLabel(p: Pick<CliProfile, 'email'> & { kind?: CliKind } | null | undefined): string {
  return p?.email || (p?.kind === 'claude_code_cli' ? 'Tài khoản Claude (chưa rõ email)' : 'Tài khoản Google (chưa rõ email)');
}

/** Friendly Vietnamese text for a failed switch / delete of a CLI account (v0.1.30). */
export function cliSwitchError(e: unknown, fallback: (e: unknown) => string): string {
  if (e instanceof PinCancelledError) return 'Chưa đổi — cần nhập mã PIN để đổi hoặc xoá tài khoản Google.';
  if (e instanceof ApiError) {
    if (e.code === 'CLI_LOGIN_IN_PROGRESS') return 'Đang đăng nhập thêm một tài khoản Google — hoàn tất hoặc bấm “Huỷ đăng nhập” trước.';
    if (e.code === 'CLI_PROFILE_NO_SESSION') return 'Tài khoản này chưa có phiên đăng nhập đã lưu — bấm “Thêm tài khoản Google” để đăng nhập lại.';
    if (e.status === 404) return 'Tài khoản này không còn nữa — danh sách vừa được làm mới.';
  }
  return fallback(e);
}

/**
 * "Google AI Pro · token 0 ₫ · còn hiệu lực 23 giờ" — plan_label carries the plan/token part.
 * v0.1.31: token ngắn hạn quá giờ mà còn refresh token → "tự gia hạn" (không còn "đã hết hiệu lực" gây hiểu nhầm);
 * hết hạn thật → nói việc cần làm.
 */
export function cliMeta(p: CliProfile, now = Date.now()): string {
  if (p.state === 'expired') return [p.plan_label, 'phiên đã hết hiệu lực — bấm “Đăng nhập lại”'].filter(Boolean).join(' · ');
  const passed = p.expires_at ? fmtRemaining(p.expires_at, now) === 'đã hết' : false;
  const left = p.expires_at ? (passed ? (p.refreshable ? 'tự gia hạn' : 'đã hết hiệu lực') : `còn hiệu lực ${fmtRemaining(p.expires_at, now)}`) : p.refreshable ? 'tự gia hạn' : null;
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

// ── Quyền hạn: ma trận (PLAN 4.5, thiết kế `permCols`/`permRows`) ───────────
// v0.1.28 (UX N7): ô ma trận nói PHẠM VI dữ liệu (tất cả / theo team / khách được phân / không), không nói "toàn
// quyền" — Auditor chỉ xem, ô ✓ của Auditor nghĩa là xem được tất cả, không phải được làm mọi thứ. Nhãn ngắn để ô
// chọn không bị cắt chữ.
export const SCOPE_CELL: Record<PermScope, { icon: string; tone: string; title: string }> = {
  all: { icon: 'ph-fill ph-check-circle', tone: OK, title: 'Tất cả dữ liệu' },
  team: { icon: 'ph ph-minus-circle', tone: WARN, title: 'Chỉ dữ liệu của team mình' },
  assigned: { icon: 'ph ph-minus-circle', tone: WARN, title: 'Chỉ khách được phân' },
  none: { icon: 'ph ph-x', tone: N5, title: 'Không được' },
};

export const SCOPE_OPTIONS: Array<{ value: PermScope; label: string }> = [
  { value: 'all', label: 'Tất cả' },
  { value: 'team', label: 'Theo team' },
  { value: 'assigned', label: 'Khách được phân' },
  { value: 'none', label: 'Không' },
];

/** v0.1.45 (F-20): "Đăng nhập", "Đăng nhập lại" và thêm tài khoản CLI đều gọi POST /cli/login — cùng cần phiên PIN. */
export const CLI_ADD_PIN_TEXT = 'Đăng nhập / thêm tài khoản cần mã PIN';

/** F-58: quyền chỉ-toàn-tổ-chức (system.manage) chỉ có "Tất cả" / "Không"; giá trị cũ team/assigned (không có tác dụng)
 *  vẫn hiện để ô chọn không trống, kèm ghi chú, và không chọn lại được. */
export function scopeOptionsFor(permission: string, current: PermScope): Array<{ value: PermScope; label: string; disabled?: boolean }> {
  if (!ALL_ONLY_PERMS.includes(permission)) return SCOPE_OPTIONS;
  const opts: Array<{ value: PermScope; label: string; disabled?: boolean }> = SCOPE_OPTIONS.filter((o) => o.value === 'all' || o.value === 'none');
  if (current !== 'all' && current !== 'none') {
    const old = SCOPE_OPTIONS.find((o) => o.value === current);
    opts.push({ value: current, label: `${old?.label ?? current} (không có tác dụng)`, disabled: true });
  }
  return opts;
}

/** v0.1.28 (UX N7): tên vai trò tiếng Việt trên giao diện (mã vai trò và tên lưu ở máy chủ giữ nguyên). */
export const ROLE_LABEL: Record<string, { name: string; meta: string }> = {
  owner: { name: 'Owner — Sếp', meta: 'thấy và làm mọi thứ' },
  manager: { name: 'Quản lý', meta: 'thấy team mình' },
  operator: { name: 'Vận hành', meta: 'xử lý hàng đợi việc' },
  agent_staff: { name: 'Nhân viên phụ trách', meta: 'chỉ khách được phân' },
  auditor: { name: 'Kiểm soát', meta: 'chỉ xem, không làm thao tác nào' },
};

export function roleLabel(code: string, fallback: string): string {
  return ROLE_LABEL[code]?.name ?? fallback;
}

/** Owner luôn `all` mọi cột; Auditor không bao giờ có quyền ghi — khoá cứng ARCHITECTURE §7.4/§8.3, ô ma
 * trận tương ứng bị khoá (disabled), không phải cho bấm rồi báo lỗi. */
const WRITE_PERMISSIONS = new Set(['queue.act', 'profile.write', 'people_review.write', 'opportunity.write', 'action.draft', 'action.approve']);
export function cellLocked(role: string, permission: string): boolean {
  if (role === 'owner') return true;
  if (role === 'auditor' && WRITE_PERMISSIONS.has(permission)) return true;
  return false;
}

// ── Quyền hạn: ranh giới có trách nhiệm ──────────────────────────────────────
export const BOUNDARY_ICON: Record<string, string> = {
  listen_authorized_only: 'ph ph-shield-check',
  disclose_staff_observation: 'ph ph-eye',
  hide_sensitive_below_owner: 'ph ph-eye-slash',
  personnel_alert_requires_evidence: 'ph ph-quotes',
  observe_external_market: 'ph ph-globe-hemisphere-east',
  auto_personnel_decisions: 'ph ph-prohibit',
  approval_gate: 'ph ph-gavel',
  mcp_write_requires_approval: 'ph ph-plugs-connected',
};

export function boundaryTone(b: Pick<Boundary, 'enabled' | 'locked'>): string {
  if (!b.enabled) return b.locked ? BAD : N5;
  return OK;
}

// ── Nhật ký hệ thống ──────────────────────────────────────────────────────────
export const AUDIT_RESULT: Record<string, { label: string; tone: string }> = {
  ok: { label: 'Thành công', tone: OK },
  held: { label: 'Chờ duyệt', tone: WARN },
  blocked: { label: 'Đã chặn', tone: BAD },
  failed: { label: 'Thất bại', tone: BAD },
};
export function auditResultView(result: string): { label: string; tone: string } {
  return AUDIT_RESULT[result] ?? { label: result, tone: N4 };
}
export function auditActorTone(actorType: string): string {
  return actorType === 'agent' ? ACC3 : actorType === 'system' ? N4 : N3;
}

// ── Dữ liệu & lưu trữ (spec I) ───────────────────────────────────────────────
export const RETENTION_LABEL: Record<string, string> = {
  'raw.events': 'Kho thô — tin nhắn nguyên bản',
  'clean.meaning_units': 'Kho sạch — ý chính từ tin nhắn',
  'ops.action_log': 'Nhật ký hành động',
  'memory.entries': 'Sổ tay nhận thức',
  'agent.model_calls': 'Lượt gọi model',
  'agent.browser_jobs.result': 'Kết quả việc trình duyệt nền',
};

/** Câu mặc định theo cách dọn khi API không gửi `note` (v0.1.40, F-2). */
const RETENTION_MODE_NOTE: Record<string, string> = {
  partition: 'Xoá theo cả tháng khi cả tháng đã quá hạn',
  batch: 'Xoá dần các dòng quá hạn mỗi đêm',
  not_applicable: 'Nhật ký hành động chỉ ghi thêm — không xoá theo hạn',
};

export interface RetentionRowView {
  /** Ô "Giữ trong". */
  keep: string;
  /** false ⇒ "Không áp dụng" (chữ thường, không mono). */
  applicable: boolean;
  /** Có nút Sửa. */
  editable: boolean;
  note: string | null;
  /** "Lần dọn gần nhất: … · đã xoá N tháng/dòng"; null = chưa dọn. */
  lastRun: string | null;
  /** Lượt dọn gần nhất của tập này lỗi ⇒ hiện tông cảnh báo (không coi "đã xoá 0" là thành công). */
  lastFailed: boolean;
  /** Hạn đặt trước v0.1.40 chưa xác nhận ⇒ chưa thi hành (câu nhắc dưới tên tập dữ liệu); null = không. */
  pending: string | null;
  /** Lý do không sửa được (vd Manager trên bảng xoá theo tháng) — hiện thành chữ, không chỉ tooltip; null = không. */
  lockedReason: string | null;
}

/** Người xem dòng hạn lưu: Owner / có quyền sửa (system.manage). Mặc định = Owner (giữ hành vi cũ). */
export interface RetentionViewer {
  isOwner: boolean;
  canManage: boolean;
}

export const RETENTION_OWNER_ONLY_REASON = 'Chỉ Owner đổi được hạn lưu của dữ liệu xoá theo tháng';

/** Tập dữ liệu mà lưu số ngày là đồng ý XOÁ VĨNH VIỄN dữ liệu quá hạn (cần hỏi lại trước khi gửi). */
export function retentionDeletes(r: RetentionPolicy): boolean {
  return r.mode !== 'not_applicable' && r.dataset !== 'ops.action_log' && r.dataset !== 'agent.browser_jobs.result';
}

/** Câu cảnh báo trước khi lưu hạn lưu (xoá vĩnh viễn ở lượt dọn kế tiếp). */
export function retentionConfirmText(r: RetentionPolicy, days: number): string {
  const what = r.mode === 'partition' ? `Mọi tháng dữ liệu đã cũ hơn ${days} ngày` : `Dữ liệu cũ hơn ${days} ngày`;
  return `${what} sẽ bị XOÁ VĨNH VIỄN ở lượt dọn kế tiếp (05:00 hằng ngày) — chỉ lấy lại được từ bản sao lưu.`;
}

/** Bảng phân vùng (xoá cả tháng cho mọi tổ chức trên máy) — chỉ Owner đổi được hạn. */
export function retentionOwnerOnly(r: RetentionPolicy): boolean {
  return r.mode === 'partition';
}

/** v0.1.40 (F-2): một dòng bảng "Hạn lưu dữ liệu" — mọi giá trị là chuỗi/bool. */
export function retentionRowView(r: RetentionPolicy, tz = DEFAULT_TZ, viewer: RetentionViewer = { isOwner: true, canManage: true }): RetentionRowView {
  const notApplicable = r.mode === 'not_applicable';
  const fixed = r.dataset === 'agent.browser_jobs.result';
  const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim() : r.mode ? (RETENTION_MODE_NOTE[r.mode] ?? null) : null;
  const keep = notApplicable
    ? 'Không áp dụng'
    : fixed
      ? `${r.keep_days ?? 14} ngày (cố định)`
      : r.keep_days != null
        ? `${r.keep_days} ngày`
        : 'mãi mãi';
  const lastFailed = !!r.last_run_at && !notApplicable && r.last_ok === false;
  const unit = r.mode === 'partition' ? 'tháng' : 'dòng';
  const lastRun =
    r.last_run_at && !notApplicable
      ? lastFailed
        ? `Lần dọn gần nhất lỗi (${fmtDM(r.last_run_at, tz)} ${fmtHM(r.last_run_at, tz)}) — hệ thống sẽ thử lại lúc 05:00`
        : `Lần dọn gần nhất: ${fmtDM(r.last_run_at, tz)} ${fmtHM(r.last_run_at, tz)}${typeof r.last_deleted === 'number' ? ` · đã xoá ${fmtInt(r.last_deleted)} ${unit}` : ''}`
      : null;
  const editable = !notApplicable && !fixed && r.editable !== false;
  const canEdit = editable && viewer.canManage && (viewer.isOwner || !retentionOwnerOnly(r));
  const pending =
    r.needs_confirm === true && r.keep_days != null && !notApplicable && !fixed
      ? canEdit
        ? 'Chưa áp dụng — hạn này đặt trước bản v0.1.40. Bấm Sửa → Lưu để xác nhận (dữ liệu quá hạn sẽ bị xoá vĩnh viễn).'
        : 'Chưa áp dụng — hạn này đặt trước bản v0.1.40. Nhờ Owner xác nhận lại hạn này.'
      : null;
  return {
    keep: pending ? `${keep} (chưa áp dụng)` : keep,
    applicable: !notApplicable,
    editable,
    note,
    lastRun,
    lastFailed,
    pending,
    lockedReason: editable && viewer.canManage && !viewer.isOwner && retentionOwnerOnly(r) ? RETENTION_OWNER_ONLY_REASON : null,
  };
}

export const DATA_REQUEST_KIND: Record<string, { label: string; icon: string; tone: string }> = {
  export: { label: 'Xuất dữ liệu', icon: 'ph ph-download-simple', tone: N3 },
  erase: { label: 'Xoá dữ liệu', icon: 'ph ph-trash', tone: BAD },
  restrict: { label: 'Giới hạn dùng', icon: 'ph ph-lock-simple', tone: WARN },
};
