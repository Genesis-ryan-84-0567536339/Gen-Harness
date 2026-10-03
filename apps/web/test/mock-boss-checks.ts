/**
 * Mock `/api/v1/boss-checks*` (v0.1.39, F-74) — "Việc Sếp cần làm": như `apps/api/gh/boss_checks` (hợp đồng gói 1).
 * CHỈ Owner (403 vai trò khác), PIN cho `hub` và `agy_switch` (423 như mock khác), mã lạ 404. Lỗi nghiệp vụ vẫn 200
 * với `status: 'fail'` + `error_code`. Kết quả giữ trong state của mock (tải lại trang vẫn còn — đọc từ API).
 *
 * - hub: dùng chung lượt "Kiểm tra" của `mock-p4-mcp` (token chứa "sai" → HUB_TOKEN_REJECTED).
 * - facebook: trả `pending`; lần GET cách lượt chạy ≥ 1,5 giây thì thành `pass` (như việc đọc chạy nền).
 * - agy_call / agy_switch / claude_call: theo hồ sơ CLI của `mock-phase2` (`account` = email hồ sơ đang dùng — CHỈ
 *   trong phản hồi `run`; `GET` như `latest()` thật chỉ có `detail.account_masked`).
 * - agy_login / claude_login: ghi trong LUỒNG đăng nhập CLI của `mock-phase2` (như `_boss_check` thật), không suy khi GET.
 * - `runs` = số bản ghi (cả lỗi); `switch_passes` = số lần đổi ĐẠT sang tài khoản khác lượt trước (như máy chủ).
 * - Lỗi tạm (SOCIAL_BUSY khi đang đọc) trả `transient: true`, không ghi.
 * - jev: theo nguồn `system_one` của `mock-phase2` (không có → JEV_NOT_CONFIGURED).
 * - claude_call đạt mà claude_login chưa đạt (phiên có từ trước v0.1.39) → ghi claude_login 'pass'
 *   (`login_source: existing_session`) như `_adopt_existing_claude_login` của api.
 * - telegram (v0.1.44, dòng 6, bắt buộc ⇒ required_total 5): Gửi thử của `mock-telegram` (chưa cấu hình →
 *   TELEGRAM_NOT_CONFIGURED; TELEGRAM_RATE_LIMITED tạm, không ghi); phản hồi `run` kèm `host_requested`.
 * - agy_switch: chỉ đếm khi hồ sơ đang dùng TRƯỚC khi đổi (`from_profile`) khác hồ sơ đích (đổi sang chính nó = 0).
 * Hook e2e `POST /api/v1/__mock/p3/bossChecks/seedAgy {}`: đặt sẵn 2 hồ sơ Google an@… (không dùng), binh@… (đang dùng).
 * Hook e2e `POST /api/v1/__mock/p3/bossChecks/seedClaude {}`: một hồ sơ Claude đang dùng, CHƯA có bản claude_login.
 */
import { randomUUID } from 'node:crypto';
import type { BossCheck, BossCheckKey, BossOverview, BossRow, CliProfile, HubLink, Provider, SocialAccount } from '@gen-harness/contracts';
import type { P2Ctx } from './mock-phase2';
import type { TelegramOutcome } from './mock-telegram';

interface Opts {
  fresh: boolean;
  emit: (type: string, data: unknown) => void;
  hubLink: () => HubLink;
  hubTest: () => { ok: boolean; error: string | null; error_code: string | null };
  socialAccounts: () => SocialAccount[];
  cliProfiles: (kind: string) => CliProfile[];
  activateCli: (id: string) => boolean;
  providers: () => Provider[];
  onCliLogin: (fn: (kind: string, ok: boolean, email: string | null) => void) => void;
  /** v0.1.44 (F-8c): một lượt Gửi thử Telegram của mock-telegram. */
  telegramTest: () => TelegramOutcome;
}

/** Như `boss.mask_email` của api: 'binh@x.vn' → 'b***@x.vn'. */
const mask = (email: string | null | undefined): string | null => {
  if (!email || !email.includes('@')) return null;
  const i = email.lastIndexOf('@');
  return i > 0 ? `${email[0]}***@${email.slice(i + 1)}` : null;
};

const KEYS: BossCheckKey[] = ['hub', 'facebook', 'agy_login', 'agy_call', 'agy_switch', 'claude_login', 'claude_call', 'jev', 'telegram'];
const RUNNABLE = new Set<BossCheckKey>(['hub', 'facebook', 'agy_call', 'agy_switch', 'claude_call', 'jev', 'telegram']);
const NEEDS_PIN = new Set<BossCheckKey>(['hub', 'agy_switch']);
const FB_READ_MS = 1500;

const ROWS: Array<Omit<BossRow, 'done'>> = [
  { row: 1, key: 'hub', title: 'Nối Gen-hub', optional: false, checks: ['hub'] },
  { row: 2, key: 'facebook', title: 'Kết nối Facebook', optional: false, checks: ['facebook'] },
  { row: 3, key: 'agy', title: 'Google (Antigravity) — hai tài khoản', optional: false, checks: ['agy_login', 'agy_call', 'agy_switch'] },
  { row: 4, key: 'claude', title: 'Claude Code CLI', optional: false, checks: ['claude_login', 'claude_call'] },
  { row: 5, key: 'jev', title: 'Jev', optional: true, checks: ['jev'] },
  { row: 6, key: 'telegram', title: 'Telegram (báo động & bản tin)', optional: false, checks: ['telegram'] },
];

export function createMock(opts: Opts) {
  const results = Object.fromEntries(KEYS.map((k) => [k, null])) as Record<BossCheckKey, BossCheck | null>;
  /** Số lần đổi tài khoản THẬT đạt (hồ sơ trước khi đổi ≠ hồ sơ đích; dòng 3 xong khi ≥ 2) — như `switch_passes`. */
  let switchPasses = 0;
  let fbStartedAt = 0;

  const now = () => new Date().toISOString();
  const record = (key: BossCheckKey, status: BossCheck['status'], extra: Partial<BossCheck> = {}): BossCheck => {
    const prev = results[key];
    const c: BossCheck = {
      key, status, error_code: null, message: null, detail: {}, checked_at: now(), runs: (prev?.runs ?? 0) + 1, ...extra,
    };
    // Bản lưu như CSDL thật: không có email đầy đủ (`account` chỉ có trong phản hồi `run`).
    const { account: _full, ...stored } = c;
    void _full;
    results[key] = stored;
    return c;
  };
  const fail = (key: BossCheckKey, code: string, message: string) => record(key, 'fail', { error_code: code, message });
  /** Lỗi tạm (bận/hạn mức) — như api: trả về nhưng KHÔNG ghi. */
  const transient = (key: BossCheckKey, code: string, message: string): BossCheck => ({
    key, status: 'fail', error_code: code, message, detail: {}, checked_at: now(), runs: 0, transient: true,
  });
  const activeOf = (kind: string) => opts.cliProfiles(kind).find((p) => p.active) ?? null;

  // Đăng nhập CLI: luồng đăng nhập của mock-phase2 báo xong/lỗi → ghi kết quả (như `_boss_check` của api thật).
  opts.onCliLogin((kind, ok, email) => {
    const key: BossCheckKey = kind === 'claude_code_cli' ? 'claude_login' : 'agy_login';
    if (ok) record(key, 'pass', { detail: { account_masked: mask(email), credentials_file: true } });
    else fail(key, 'CLI_LOGIN_FAILED', 'Đăng nhập chưa xong — bấm Đăng nhập lại, mở link mới và dán đúng mã vừa nhận');
  });

  const syncLogins = () => {
    const fb = results.facebook;
    if (fb?.status === 'pending' && Date.now() - fbStartedAt >= FB_READ_MS) {
      results.facebook = { ...fb, status: 'pass', checked_at: now(), detail: { items: 3 } };
    }
  };

  /** Gửi thử Telegram: lỗi tạm (TELEGRAM_RATE_LIMITED) không ghi; còn lại ghi như máy chủ, kèm `host_requested`. */
  const recordTelegram = (o: TelegramOutcome): BossCheck => {
    const { transient: isTransient, host_requested, ...rest } = o;
    if (isTransient) return { ...transient('telegram', o.error_code ?? 'TELEGRAM_RATE_LIMITED', o.message ?? ''), detail: rest.detail, host_requested } as BossCheck;
    return { ...record('telegram', rest.status, { error_code: rest.error_code, message: rest.message, detail: rest.detail }), host_requested } as BossCheck;
  };

  /** Như `telegram.service.forget_tests` của api: đổi token/chat_id hoặc Tắt Telegram ⇒ dòng 6 về "Chưa kiểm". */
  const forgetTelegram = () => {
    results.telegram = null;
  };

  const pass = (k: BossCheckKey) => results[k]?.status === 'pass';
  const overview = (): BossOverview => {
    syncLogins();
    const done: Record<number, boolean> = {
      1: pass('hub'),
      2: pass('facebook'),
      3: pass('agy_call') && switchPasses >= 2,
      4: pass('claude_login') && pass('claude_call'),
      5: pass('jev'),
      6: pass('telegram'),
    };
    const rows = ROWS.map((r) => ({ ...r, done: done[r.row] }));
    return { rows, results: { ...results }, required_done: rows.filter((r) => !r.optional && r.done).length, required_total: 5, switch_passes: switchPasses };
  };

  const run = (key: BossCheckKey, body: { profile_id?: string; account_id?: string }): BossCheck | null => {
    switch (key) {
      case 'hub': {
        if (!opts.hubLink().configured) return fail('hub', 'HUB_LINK_NOT_CONFIGURED', 'Chưa nhập địa chỉ và token Gen-hub');
        const t = opts.hubTest();
        return t.ok ? record('hub', 'pass', { detail: { tools: 3 } }) : fail('hub', t.error_code ?? 'HUB_ERROR', t.error ?? 'Gen-hub báo lỗi');
      }
      case 'facebook': {
        const acc = opts.socialAccounts().find((a) => a.id === body.account_id && a.status !== 'revoked');
        if (!acc) return fail('facebook', 'SOCIAL_NO_ACCOUNT', 'Chưa có tài khoản Facebook');
        if (acc.status !== 'active') return fail('facebook', 'SOCIAL_NOT_ACTIVE', 'Tài khoản chưa đăng nhập');
        if (results.facebook?.status === 'pending')
          return { ...transient('facebook', 'SOCIAL_BUSY', 'Tài khoản này đang có một việc chạy') };
        fbStartedAt = Date.now();
        return record('facebook', 'pending', { detail: { account_id: acc.id } });
      }
      case 'agy_call': {
        const a = activeOf('antigravity_cli');
        return a ? record('agy_call', 'pass', { account: a.email, detail: { account_masked: mask(a.email) } }) : fail('agy_call', 'AGY_NOT_LOGGED_IN', 'Chưa đăng nhập Google cho Antigravity');
      }
      case 'agy_switch': {
        const p = opts.cliProfiles('antigravity_cli').find((x) => x.id === body.profile_id);
        if (!p) return null;
        const from = activeOf('antigravity_cli')?.id ?? null;
        opts.activateCli(p.id);
        if (from !== p.id) switchPasses += 1;
        return record('agy_switch', 'pass', {
          account: p.email,
          detail: { expected_masked: mask(p.email), account_masked: mask(p.email), account_match: true, target_profile: p.id, from_profile: from },
        });
      }
      case 'claude_call': {
        const a = activeOf('claude_code_cli');
        if (!a) return fail('claude_call', 'CLAUDE_NOT_LOGGED_IN', 'Chưa đăng nhập Claude Code');
        const out = record('claude_call', 'pass', { account: a.email, detail: { account_masked: mask(a.email) } });
        if (!pass('claude_login')) record('claude_login', 'pass', { detail: { login_source: 'existing_session', account_masked: mask(a.email), credentials_file: true } });
        return out;
      }
      case 'telegram':
        return recordTelegram(opts.telegramTest());
      case 'jev': {
        const jev = opts.providers().find((p) => p.kind === 'system_one');
        return jev ? record('jev', 'pass') : fail('jev', 'JEV_NOT_CONFIGURED', 'Chưa nhập khoá Jev');
      }
      default:
        return null;
    }
  };

  function handle(ctx: P2Ctx): boolean {
    const { method: m, path: p, body, reply, problem } = ctx;
    if (p !== '/boss-checks' && !p.startsWith('/boss-checks/')) return false;
    if (ctx.role !== 'owner') return problem(403, 'FORBIDDEN', 'Vai trò của bạn không có quyền thao tác này');
    if (p === '/boss-checks' && m === 'GET') return reply(200, overview());
    const mm = /^\/boss-checks\/([a-z_]+)\/run$/.exec(p);
    if (mm && m === 'POST') {
      const key = mm[1] as BossCheckKey;
      if (!RUNNABLE.has(key)) return problem(404, 'NOT_FOUND', 'Không có mục kiểm này');
      if (NEEDS_PIN.has(key) && ctx.needPin()) return problem(423, 'PIN_REQUIRED', 'Thao tác này cần nhập mã PIN', { detail: { operation: `boss_checks.${key}` } });
      const c = run(key, body as { profile_id?: string; account_id?: string });
      if (!c) return problem(404, 'NOT_FOUND', 'Không tìm thấy tài khoản');
      opts.emit('boss_checks.update', { key });
      return reply(200, c);
    }
    return false;
  }

  /** Hook e2e: hai hồ sơ Google an@ (không dùng) và binh@ (đang dùng) cho kịch bản đổi qua lại. */
  const seedAgy = () => {
    const list = opts.cliProfiles('antigravity_cli');
    const exp = new Date(Date.now() + 5 * 86_400_000).toISOString();
    list.splice(0, list.length,
      { id: randomUUID(), email: 'an@genesis.vn', plan_label: 'Google AI · miễn phí', active: false, expires_at: exp, state: 'ok' },
      { id: randomUUID(), email: 'binh@genesis.vn', plan_label: 'Google AI Pro', active: true, expires_at: exp, state: 'ok' },
    );
    return list;
  };

  /** Hook e2e: một hồ sơ Claude đang dùng, chưa có bản claude_login (như phiên có từ trước v0.1.39). */
  const seedClaude = () => {
    const list = opts.cliProfiles('claude_code_cli');
    const exp = new Date(Date.now() + 5 * 86_400_000).toISOString();
    list.splice(0, list.length, { id: randomUUID(), email: 'ryan@claude.ai', plan_label: 'Claude Max', active: true, expires_at: exp, state: 'ok' });
    return list;
  };

  return { handle, hooks: { seedAgy, seedClaude, overview, recordTelegram, forgetTelegram } as Record<string, (...args: never[]) => unknown>, dispose: () => {} };
}
