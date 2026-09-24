/**
 * In-memory mock of the API (docs/api/phase-1.md + phase-2.md) for
 * `npm run dev:mock` and the Playwright tests. Not shipped in the bundle.
 *
 *   owner@genesis.local / matkhau-rat-dai-2026, PIN 246810    (role owner)
 *   operator@genesis.local / matkhau-rat-dai-2026, PIN 135790 (role operator, fewer screens)
 *   auditor@genesis.local / matkhau-rat-dai-2026, PIN 975310  (role auditor, read-only)
 *   setup token: GH-SETUP-7Q4K-2M9X
 *
 * MOCK_SETUP=fresh starts at step 1; MOCK_LATENCY=<ms> delays every response;
 * MOCK_SIMULATE=0 turns off the live raw-message simulation.
 * `/api/v1/ws` is served by `upgrade()` (see vite.config.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createPhase2, maskText, type P2Ctx } from './mock-phase2';
import { createMock as createP3Core } from './mock-p3-core';
import { createMock as createP3Queue } from './mock-p3-queue';
import { createMock as createP3Relations } from './mock-p3-relations';
import { createMock as createP3Graph } from './mock-p3-graph';
import { createMock as createP3Market } from './mock-p3-market';
import { createMock as createP3People } from './mock-p3-people';
import { acceptWebSocket, type MockSocket } from './mock-ws';
import { buildScreenTree, SCREEN_BY_KEY } from '../../../packages/contracts/src/screens';
import type { NavDomain, NavItem, SetupState } from '../../../packages/contracts/src/schema';

type Next = (err?: unknown) => void;

export const MOCK_TOKEN = 'GH-SETUP-7Q4K-2M9X';
export const MOCK_OWNER = { email: 'owner@genesis.local', password: 'matkhau-rat-dai-2026', pin: '246810' };

/** Badge values shown in the design, served so the shell can be compared with it. */
const DESIGN_BADGES: Record<string, { value: string; tone: 'ok' | 'warn' | 'bad' }> = {
  overview: { value: '9', tone: 'bad' },
  inbox: { value: '28', tone: 'warn' },
  workbench: { value: '6', tone: 'warn' },
  opportunity: { value: '41', tone: 'ok' },
  supply: { value: '27', tone: 'ok' },
  raw: { value: '18k', tone: 'warn' },
  identity: { value: '12', tone: 'warn' },
  mcp: { value: '7', tone: 'ok' },
  plugins: { value: '11', tone: 'ok' },
};

interface User {
  id: string;
  email: string;
  password: string;
  pin: string;
  display_name: string;
  role: { code: RoleCode; name: string };
  hidden: Set<string>;
}

export interface MockOptions {
  setup?: 'fresh' | 'finished';
  latencyMs?: number;
  badges?: boolean;
  /** Live raw-message / QR-scan simulation (default on; MOCK_SIMULATE=0 turns it off). */
  simulate?: boolean;
  /** Let `PUT /setup/steps/12` finish without steps 8–9 (the real API refuses in phase 2). */
  allowFinish?: boolean;
}

// RBAC as apps/api gh/auth/rbac.py seeds it: Owner, Manager, Operator, Agent NV, Auditor.
type RoleCode = 'owner' | 'manager' | 'operator' | 'agent_staff' | 'auditor';
const ROLE_ORDER: RoleCode[] = ['owner', 'manager', 'operator', 'agent_staff', 'auditor'];
const MATRIX: Record<string, [string, string, string, string, string]> = {
  'overview.read': ['all', 'team', 'assigned', 'none', 'all'],
  'queue.read': ['all', 'team', 'all', 'assigned', 'all'],
  'queue.act': ['all', 'team', 'all', 'assigned', 'none'],
  'profile.read': ['all', 'team', 'all', 'assigned', 'all'],
  'profile.write': ['all', 'team', 'all', 'assigned', 'none'],
  'people_review.read': ['all', 'none', 'none', 'none', 'none'],
  'people_review.write': ['all', 'none', 'none', 'none', 'none'],
  'care.read': ['all', 'none', 'none', 'none', 'none'],
  'opportunity.read': ['all', 'team', 'all', 'assigned', 'all'],
  'opportunity.write': ['all', 'team', 'all', 'assigned', 'none'],
  'action.draft': ['all', 'team', 'assigned', 'assigned', 'none'],
  'action.approve': ['all', 'team', 'none', 'none', 'none'],
  'audit.read': ['all', 'team', 'none', 'none', 'all'],
  'data.read': ['all', 'none', 'none', 'none', 'all'],
  'data.manage': ['all', 'none', 'none', 'none', 'none'],
  'system.read': ['all', 'none', 'none', 'none', 'all'],
  'system.manage': ['all', 'none', 'none', 'none', 'none'],
  'roles.manage': ['all', 'none', 'none', 'none', 'none'],
};
const SCREEN_PERMISSION: Record<string, string[]> = {
  overview: ['overview.read'], inbox: ['queue.read'], workbench: ['action.draft', 'action.approve'],
  directory: ['profile.read'], graph: ['profile.read'], profile: ['profile.read'], notebook: ['profile.read'],
  opportunity: ['opportunity.read'], supply: ['opportunity.read'], search: ['opportunity.read'],
  people: ['people_review.read'], care: ['care.read'],
  raw: ['data.read'], rules: ['data.read'], clean: ['data.read'], identity: ['data.read'],
  agents: ['system.read'], api: ['system.read'], mcp: ['system.read'], plugins: ['system.read'],
  system: ['system.read', 'audit.read'],
};
export function permissionsOf(role: RoleCode): Record<string, string> {
  const i = ROLE_ORDER.indexOf(role);
  return Object.fromEntries(Object.entries(MATRIX).map(([k, v]) => [k, v[i]]));
}
function hiddenScreens(role: RoleCode): Set<string> {
  const perms = permissionsOf(role);
  return new Set(Object.entries(SCREEN_PERMISSION).filter(([, need]) => !need.some((p) => perms[p] !== 'none')).map(([k]) => k));
}
/** Which realtime events a connection may receive (docs/api/phase-2.md § WebSocket). */
const EVENT_PERMISSION: Array<[string, string | null]> = [
  ['raw.', 'data.read'],
  ['refinery.', 'data.read'],
  ['channel.', 'system.read'],
  ['cli.', 'system.manage'],
  ['header', null],
];

export function buildNavigation(hidden: Set<string> = new Set(), badges = true): NavDomain[] {
  const leaf = (key: string, name: string, en: string, icon: string): NavItem => ({
    key,
    name,
    en,
    icon,
    badge: badges ? (DESIGN_BADGES[key] ?? null) : null,
    children: [],
  });
  return buildScreenTree()
    .map((d) => {
      const groups: NavItem[] = [];
      for (const e of d.entries) {
        if (e.kind === 'screen') {
          if (!hidden.has(e.screen.key)) groups.push(leaf(e.screen.key, e.screen.name, e.screen.en, e.screen.icon));
          continue;
        }
        const g = e.group;
        const children = g.children.filter((c) => !hidden.has(c.key)).map((c) => leaf(c.key, c.name, c.en, c.icon));
        const self = g.key && !hidden.has(g.key) ? leaf(g.key, g.name, SCREEN_BY_KEY[g.key].en, g.icon) : null;
        if (self) {
          groups.push({ ...self, children });
        } else if (children.length) {
          groups.push({ key: null, name: g.name, icon: g.icon, badge: null, children });
        }
      }
      const count = groups.reduce((n, g) => n + (g.key ? 1 : 0) + (g.children?.length ?? 0), 0);
      return {
        domain: d.id,
        label: d.label,
        crumb: d.crumb,
        icon: d.icon,
        tone: d.id === 'business' ? ('ok' as const) : ('accent' as const),
        count,
        groups,
      };
    })
    .filter((d) => d.groups.length > 0);
}

/** [key, title, required, available] — phase 2 serves 1–7 and 12. */
const STEP_DEFS: Array<[string, string, boolean, boolean]> = [
  ['welcome', 'Chào mừng', true, true],
  ['owner', 'Tài khoản Owner', true, true],
  ['org', 'Tổ chức & xưng hô', true, true],
  ['brain', 'Bộ não AI', true, true],
  ['channels', 'Kết nối kênh', true, true],
  ['groups', 'Chọn nhóm lắng nghe', true, true],
  ['refinery', 'Sàng lọc dữ liệu', true, true],
  ['agent', 'Agent đầu tiên', true, false],
  ['autonomy', 'Tự trị & ranh giới', true, false],
  ['team', 'Mời đội ngũ', false, false],
  ['backup', 'Sao lưu', false, false],
  ['finish', 'Hoàn tất', true, true],
];

interface AuditRow {
  id: string;
  at: string;
  actor_type: string;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  autonomy_level: number | null;
  result: string;
  detail: unknown;
}

function createMockState(opts: MockOptions = {}, broadcast: (type: string, data: unknown) => void = () => {}) {
  const latency = opts.latencyMs ?? Number(process.env.MOCK_LATENCY ?? 0);
  /** Test-only: let step 12 finish although 8–9 (not built in phase 2) are missing. */
  const mockAllowFinish = opts.allowFinish ?? false;
  const phase2 = createPhase2({
    fresh: opts.setup === 'fresh',
    simulate: opts.simulate ?? process.env.MOCK_SIMULATE !== '0',
    emit: broadcast,
  });
  /** Giai đoạn 3: mỗi cụm màn một mock riêng (test/mock-p3-*.ts), hỏi lần lượt sau phase 2. */
  const phase3 = {
    core: createP3Core({ fresh: opts.setup === 'fresh', emit: broadcast }),
    queue: createP3Queue({ fresh: opts.setup === 'fresh', emit: broadcast }),
    relations: createP3Relations({ fresh: opts.setup === 'fresh', emit: broadcast }),
    graph: createP3Graph({ fresh: opts.setup === 'fresh', emit: broadcast }),
    market: createP3Market({ fresh: opts.setup === 'fresh', emit: broadcast }),
    people: createP3People({ fresh: opts.setup === 'fresh', emit: broadcast }),
  };
  const audit: AuditRow[] = [];
  const record = (user: User | undefined, action: string, result = 'ok', detail: unknown = null) =>
    audit.unshift({
      id: randomUUID(),
      at: new Date().toISOString(),
      actor_type: 'user',
      actor_id: user?.id ?? null,
      actor_label: user?.display_name ?? null,
      action,
      target_type: 'user',
      target_id: user?.id ?? null,
      target_label: user?.email ?? null,
      autonomy_level: null,
      result,
      detail,
    });
  const users: User[] = [];
  const addOwner = (email = MOCK_OWNER.email, password = MOCK_OWNER.password, pin = MOCK_OWNER.pin, name = 'Anh Cơ La (Ryan)') =>
    users.push({
      id: randomUUID(),
      email,
      password,
      pin,
      display_name: name,
      role: { code: 'owner', name: 'Owner — Sếp' },
      hidden: hiddenScreens('owner'),
    });

  const setup: SetupState & { org: { name: string; timezone: string; currency: string }; addressing: { self: string; bot_calls_me: string } } = {
    finished: opts.setup !== 'fresh',
    current_step: opts.setup === 'fresh' ? 1 : 12,
    steps: STEP_DEFS.map(([key, title, required, available], i) => ({
      n: i + 1,
      key,
      title,
      required,
      available,
      status: opts.setup === 'fresh' ? (i === 0 ? 'doing' : 'todo') : 'done',
    })),
    org: { name: 'Genesis Trading', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
    addressing: { self: 'Anh', bot_calls_me: 'Sếp' },
  };
  if (opts.setup !== 'fresh') {
    addOwner();
    users.push({
      id: randomUUID(),
      email: 'operator@genesis.local',
      password: MOCK_OWNER.password,
      pin: '135790',
      display_name: 'Chị Lan Phạm',
      role: { code: 'operator', name: 'Operator · vận hành' },
      hidden: hiddenScreens('operator'),
    });
    users.push({
      id: randomUUID(),
      email: 'auditor@genesis.local',
      password: MOCK_OWNER.password,
      pin: '975310',
      display_name: 'Anh Minh Kiểm',
      role: { code: 'auditor', name: 'Auditor · kiểm toán' },
      hidden: hiddenScreens('auditor'),
    });
  }

  const sessions = new Map<string, { userId: string; pinUntil: number | null }>();
  const pinFails = new Map<string, { count: number; lockedUntil: number | null }>();
  const plugins = [
    { package: '@gen/chassis-store', name: 'Store · SSOT', layer: 'chassis', origin: 'core', enabled: true },
    { package: '@gen/channel-zalo', name: 'Kênh Zalo', layer: 'channel', origin: 'marketplace', enabled: true },
  ];

  const stateView = (): SetupState => ({ finished: setup.finished, current_step: setup.current_step, steps: setup.steps });
  const advance = (n: number, status: 'done' | 'skipped') => {
    const s = setup.steps[n - 1];
    s.status = status;
    const next = setup.steps.find((x) => x.status === 'todo' || x.status === 'doing');
    setup.current_step = next ? next.n : 12;
    setup.steps.forEach((x) => {
      if (x.status === 'doing') x.status = 'todo';
    });
    const cur = setup.steps[setup.current_step - 1];
    if (cur.status === 'todo') cur.status = 'doing';
  };

  function sessionUser(req: IncomingMessage) {
    const sid = parseCookies(req).gh_session;
    const session = sid ? sessions.get(sid) : undefined;
    const user = session ? users.find((u) => u.id === session.userId) : undefined;
    return user && session ? { user, session } : null;
  }

  function parseCookies(req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k) out[k] = decodeURIComponent(v.join('='));
    }
    return out;
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  function send(res: ServerResponse, status: number, body?: unknown, cookies: string[] = []) {
    const headers: Record<string, string | string[]> = { 'Cache-Control': 'no-store' };
    if (cookies.length) headers['Set-Cookie'] = cookies;
    if (status === 204 || body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    headers['Content-Type'] = status >= 400 ? 'application/problem+json' : 'application/json';
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }
  const problem = (res: ServerResponse, status: number, code: string, title: string, extra: Record<string, unknown> = {}) =>
    send(res, status, { type: `https://gen-harness.local/errors/${code.toLowerCase()}`, title, status, code, ...extra });

  function me(user: User, pinUntil: number | null) {
    return {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      role: user.role,
      org: { id: 'org-1', ...setup.org },
      addressing: setup.addressing,
      pin_verified_until: pinUntil && pinUntil > Date.now() ? new Date(pinUntil).toISOString() : null,
      permissions: permissionsOf(user.role.code),
    };
  }

  const middleware = async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const url = new URL(req.url ?? '/', 'http://mock.local');
    if (!url.pathname.startsWith('/api/v1/')) return next();
    if (latency) await new Promise((r) => setTimeout(r, latency));
    const path = url.pathname.slice('/api/v1'.length);
    const method = (req.method ?? 'GET').toUpperCase();
    const cookies = parseCookies(req);
    const setCookies: string[] = [];

    // CSRF double-submit: issue gh_csrf when missing, check it on writes.
    let csrf = cookies.gh_csrf;
    if (!csrf) {
      csrf = randomUUID();
      setCookies.push(`gh_csrf=${csrf}; Path=/; SameSite=Strict`);
    }
    const reply = (status: number, body?: unknown, extra: string[] = []) => send(res, status, body, [...setCookies, ...extra]);
    if (method !== 'GET' && method !== 'HEAD' && req.headers['x-csrf-token'] !== cookies.gh_csrf) {
      return problem(res, 403, 'CSRF_FAILED', 'CSRF token không khớp');
    }

    const sid = cookies.gh_session;
    const session = sid ? sessions.get(sid) : undefined;
    const user = session ? users.find((u) => u.id === session.userId) : undefined;
    const login = (u: User) => {
      const id = randomUUID();
      sessions.set(id, { userId: u.id, pinUntil: null });
      return `gh_session=${id}; Path=/; HttpOnly; SameSite=Strict`;
    };
    const body = method === 'GET' ? {} : await readBody(req);

    // ── health / setup (no auth) ──
    if (path === '/health') return reply(200, { status: 'ok' });
    if (path === '/ready') return reply(200, { db: 'ok', redis: 'ok', objects: 'skip', bridge: 'down' });
    if (path === '/setup/state' && method === 'GET') return reply(200, stateView());
    if (path.startsWith('/setup/')) {
      if (path === '/setup/rule-presets' && method === 'GET') return reply(200, phase2.rulePresets());
      if (path === '/setup/first-run' && method === 'GET') return reply(200, phase2.firstRunView());
      if (setup.finished) return problem(res, 409, 'CONFLICT', 'Thiết lập đã hoàn tất');
      const skip = /^\/setup\/steps\/(\d+)\/skip$/.exec(path);
      if (skip && method === 'POST') {
        const n = Number(skip[1]);
        const step = setup.steps[n - 1];
        if (!step || step.required) return problem(res, 409, 'CONFLICT', 'Bước này bắt buộc');
        advance(n, 'skipped');
        return reply(200, stateView());
      }
      const m = /^\/setup\/steps\/(\d+)$/.exec(path);
      if (m && method === 'PUT') {
        const n = Number(m[1]);
        if (n === 1 || n === 2) {
          if (body.token !== MOCK_TOKEN) return problem(res, 403, 'SETUP_TOKEN_INVALID', 'Mã thiết lập không hợp lệ');
        }
        if (n === 1) {
          advance(1, 'done');
          return reply(200, stateView());
        }
        if (n === 2) {
          const errors: Record<string, string> = {};
          if (String(body.password ?? '').length < 12) errors.password = 'Mật khẩu cần ít nhất 12 ký tự.';
          if (!/^\d{6}$/.test(String(body.pin ?? ''))) errors.pin = 'PIN gồm đúng 6 chữ số.';
          if (body.pin !== body.pin_confirm) errors.pin_confirm = 'Hai lần nhập PIN chưa khớp.';
          if (users.some((u) => u.email === body.email)) errors.email = 'Email đã được dùng.';
          if (Object.keys(errors).length) return problem(res, 422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors });
          addOwner(String(body.email), String(body.password), String(body.pin), String(body.display_name));
          advance(2, 'done');
          return reply(200, stateView(), [login(users[users.length - 1])]);
        }
        if (n === 3) {
          if (!user) return problem(res, 401, 'UNAUTHENTICATED', 'Chưa đăng nhập');
          setup.org = { name: String(body.org_name), timezone: String(body.timezone), currency: String(body.currency) };
          setup.addressing = { self: String(body.self_name), bot_calls_me: String(body.bot_calls_me) };
          advance(3, 'done');
          return reply(200, stateView());
        }
        if ([4, 5, 6, 7, 12].includes(n)) {
          if (!user) return problem(res, 401, 'UNAUTHENTICATED', 'Chưa đăng nhập');
          if (setup.current_step < 4) return problem(res, 409, 'STEP_ORDER', 'Làm các bước trước trước');
          const r = phase2.setupStep(n, body);
          if (!('ok' in r)) return problem(res, r.status, r.code, r.title, r.extra ?? {});
          if (n === 12) {
            // As the API: finishing needs every required step; phase 2 has no 8–9 yet → 409 naming them.
            const missing = setup.steps.filter((x) => x.required && x.n !== 12 && x.status !== 'done').map((x) => x.n);
            if (missing.length && !mockAllowFinish) {
              return problem(res, 409, 'STEP_INCOMPLETE', `Còn bước bắt buộc chưa xong: ${missing.join(', ')}`);
            }
            setup.steps[11].status = 'done';
            setup.finished = true;
            setup.current_step = 12;
          } else advance(n, 'done');
          return reply(200, stateView());
        }
        return problem(res, 409, 'CONFLICT', 'Bước này làm ở giai đoạn sau');
      }
      return problem(res, 404, 'NOT_FOUND', 'Không tồn tại');
    }

    // ── auth ──
    if (path === '/auth/login' && method === 'POST') {
      const u = users.find((x) => x.email === body.email && x.password === body.password);
      if (!u) return problem(res, 401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng');
      if (!setup.finished && setup.current_step < 3) return problem(res, 428, 'SETUP_REQUIRED', 'Chưa thiết lập xong');
      return reply(200, me(u, null), [login(u)]);
    }
    if (path === '/auth/logout' && method === 'POST') {
      if (sid) sessions.delete(sid);
      return reply(204, undefined, ['gh_session=; Path=/; Max-Age=0']);
    }

    // Giống API thật (gh/middleware.py): trước khi xong bước 1–3, mọi route Console kể cả /auth/me trả 428.
    if (!setup.finished && setup.current_step <= 3 && !path.startsWith('/auth/pin')) {
      return problem(res, 428, 'SETUP_REQUIRED', 'Chưa thiết lập xong');
    }
    if (!user || !session) return problem(res, 401, 'UNAUTHENTICATED', 'Chưa đăng nhập hoặc phiên đã hết hạn');

    if (path === '/auth/me' && method === 'GET') return reply(200, me(user, session.pinUntil));
    if (path === '/auth/pin/verify' && method === 'POST') {
      const f = pinFails.get(user.id) ?? { count: 0, lockedUntil: null };
      if (f.lockedUntil && f.lockedUntil > Date.now()) {
        const lockedUntil = new Date(f.lockedUntil).toISOString();
        record(user, 'auth.pin_attempt_while_locked', 'denied');
        return problem(res, 423, 'PIN_LOCKED', 'PIN bị khoá', { detail: { locked_until: lockedUntil } });
      }
      if (body.pin !== user.pin) {
        f.count += 1;
        if (f.count >= 5) {
          f.lockedUntil = Date.now() + 15 * 60_000;
          f.count = 0;
          pinFails.set(user.id, f);
          record(user, 'auth.pin_locked', 'denied');
          return problem(res, 423, 'PIN_LOCKED', 'PIN bị khoá', { detail: { locked_until: new Date(f.lockedUntil).toISOString() } });
        }
        pinFails.set(user.id, f);
        record(user, 'auth.pin_failed', 'denied', { attempts_left: 5 - f.count });
        return problem(res, 401, 'PIN_INVALID', 'PIN không đúng', { attempts_left: 5 - f.count });
      }
      pinFails.delete(user.id);
      session.pinUntil = Date.now() + 30 * 60_000;
      record(user, 'auth.pin_verified');
      return reply(200, { pin_verified_until: new Date(session.pinUntil).toISOString() });
    }
    const needPin = () => !session.pinUntil || session.pinUntil < Date.now();
    if (path === '/auth/pin' && method === 'PUT') {
      if (needPin()) return problem(res, 423, 'PIN_REQUIRED', 'Cần phiên PIN', { detail: { operation: 'pin.change' } });
      if (body.current_pin !== user.pin) {
        record(user, 'auth.pin_failed', 'denied');
        return problem(res, 401, 'PIN_INVALID', 'PIN hiện tại không đúng');
      }
      if (!/^\d{6}$/.test(String(body.new_pin ?? ''))) {
        return problem(res, 422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors: { new_pin: 'PIN gồm đúng 6 chữ số.' } });
      }
      user.pin = String(body.new_pin);
      record(user, 'auth.pin_changed');
      return reply(204);
    }

    if (path === '/navigation' && method === 'GET') return reply(200, buildNavigation(user.hidden, opts.badges ?? true));
    if (path === '/header' && method === 'GET') {
      return reply(200, { channels_live: 4, groups_listening: 42, autonomy_level: 4, data_confidence: 0.78 });
    }
    if (path === '/plugins' && method === 'GET') return reply(200, plugins);
    const toggle = /^\/plugins\/(.+)\/toggle$/.exec(path);
    if (toggle && method === 'PATCH') {
      if (needPin()) return problem(res, 423, 'PIN_REQUIRED', 'Cần phiên PIN');
      const p = plugins.find((x) => x.package === decodeURIComponent(toggle[1]));
      if (!p) return problem(res, 404, 'NOT_FOUND', 'Không tồn tại');
      p.enabled = Boolean(body.enabled);
      return reply(200, p);
    }
    if (path === '/audit' && method === 'GET') {
      if (permissionsOf(user.role.code)['audit.read'] === 'none') return problem(res, 403, 'FORBIDDEN', 'Vai trò không có quyền này');
      const prefix = url.searchParams.get('action') ?? '';
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return reply(200, { items: audit.filter((a) => a.action.startsWith(prefix)).slice(0, limit), next_cursor: null });
    }
    if (path === '/audit/verify' && method === 'GET') return reply(200, { ok: true, checked: audit.length, broken_at: null });

    const ctx: P2Ctx = {
      method,
      path,
      url,
      body,
      perms: permissionsOf(user.role.code),
      reply: (status, b) => {
        reply(status, b);
        return true;
      },
      problem: (status, code, title, extra) => {
        problem(res, status, code, title, extra);
        return true;
      },
      text: (status, contentType, text, filename) => {
        const headers: Record<string, string | string[]> = { 'Content-Type': contentType, 'Cache-Control': 'no-store' };
        if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`;
        if (setCookies.length) headers['Set-Cookie'] = setCookies;
        res.writeHead(status, headers);
        res.end(text);
        return true;
      },
      needPin,
      userLabel: user.display_name,
      owner: user.role.code === 'owner',
    };
    if (phase2.handle(ctx)) return;
    for (const m of Object.values(phase3)) if (m.handle(ctx)) return;

    return problem(res, 404, 'NOT_FOUND', 'Không tồn tại');
  };

  return { middleware, setup, users, sessions, phase2, phase3, sessionUser };
}

/**
 * Mock API with test-only hooks (all POST, JSON body):
 *   /api/v1/__mock/reset    {"setup":"fresh"|"finished","simulate":bool,"allowFinish":bool} rebuilds the state
 *   /api/v1/__mock/emit     {"type","data"} broadcasts one realtime frame
 *   /api/v1/__mock/raw      {} pushes one simulated raw message (raw.new → raw.state)
 *   /api/v1/__mock/scan     {"type":"zalo"} simulates the phone scanning the QR
 *   /api/v1/__mock/simulate {"on":bool} toggles the background simulation
 *   /api/v1/__mock/bridge   {"online":bool} makes channel login answer 503 BRIDGE_OFFLINE
 */
export function createMockApi(opts: MockOptions = {}) {
  const clients = new Set<MockSocket>();
  const allowed = (ws: MockSocket, type: string) => {
    const perms = (ws.meta.perms ?? {}) as Record<string, string>;
    const rule = EVENT_PERMISSION.find(([prefix]) => type.startsWith(prefix));
    if (!rule) return true;
    return rule[1] === null || (!!perms[rule[1]] && perms[rule[1]] !== 'none');
  };
  const broadcast = (type: string, data: unknown) => {
    const at = new Date().toISOString();
    const frame = JSON.stringify({ type, data, at });
    let masked: string | null = null;
    for (const ws of clients) {
      if (!ws.open || !allowed(ws, type)) continue;
      // As the API (gh/realtime.py): raw.new text is masked for roles below Owner.
      if (type === 'raw.new' && ws.meta.role !== 'owner') {
        const d = data as { text?: string | null };
        masked ??= JSON.stringify({ type, data: { ...d, text: maskText(d.text ?? null) }, at });
        ws.send(masked);
      } else ws.send(frame);
    }
  };
  let current = createMockState(opts, broadcast);

  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const done = (res: ServerResponse, status = 204, body?: unknown) => {
    res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  const middleware = async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const hook = /^\/api\/v1\/__mock\/(\w+)/.exec(req.url ?? '');
    if (hook && req.method === 'POST') {
      const body = await readJson(req);
      switch (hook[1]) {
        case 'reset':
          current.phase2.dispose();
          for (const m of Object.values(current.phase3)) m.dispose();
          for (const ws of clients) ws.close(4401, 'reset');
          clients.clear();
          current = createMockState({ ...opts, ...(body as MockOptions) }, broadcast);
          return done(res);
        case 'emit':
          broadcast(String(body.type), body.data);
          return done(res);
        case 'raw':
          return done(res, 200, current.phase2.hooks.pushRaw());
        case 'scan':
          return done(res, current.phase2.hooks.scan(String(body.type ?? 'zalo')) ? 204 : 409);
        case 'simulate':
          current.phase2.hooks.setSimulation(Boolean(body.on));
          return done(res);
        case 'bridge':
          current.phase2.hooks.setBridge(Boolean(body.online));
          return done(res);
        default:
          return done(res, 404);
      }
    }
    return current.middleware(req, res, next);
  };

  /** HTTP upgrade handler for `/api/v1/ws` (other paths are left alone, e.g. Vite HMR). */
  const upgrade = (req: IncomingMessage, socket: Duplex) => {
    const url = new URL(req.url ?? '/', 'http://mock.local');
    if (url.pathname !== '/api/v1/ws') return false;
    const state = current;
    const auth = state.sessionUser(req);
    const ws = acceptWebSocket(
      req,
      socket,
      (conn, text) => {
        try {
          const msg = JSON.parse(text) as { type?: string };
          if (msg.type === 'ping') conn.send(JSON.stringify({ type: 'pong', data: null, at: new Date().toISOString() }));
        } catch {
          /* ignore */
        }
      },
      (conn) => clients.delete(conn),
    );
    if (!ws) return true;
    if (!state.setup.finished && state.setup.current_step <= 3) {
      ws.close(4428, 'SETUP_REQUIRED');
      return true;
    }
    if (!auth) {
      ws.close(4401, 'UNAUTHENTICATED');
      return true;
    }
    ws.meta.perms = permissionsOf(auth.user.role.code);
    ws.meta.role = auth.user.role.code;
    clients.add(ws);
    return true;
  };

  return {
    middleware,
    upgrade,
    get state() {
      return current;
    },
  };
}
