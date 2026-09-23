/**
 * Tiny in-memory mock of the phase-1 API (docs/api/phase-1.md) for
 * `npm run dev:mock` and the Playwright tests. Not shipped in the bundle.
 *
 *   owner@genesis.local / matkhau-rat-dai-2026, PIN 246810   (role owner)
 *   operator@genesis.local / matkhau-rat-dai-2026, PIN 135790 (role operator, fewer screens)
 *   setup token: GH-SETUP-7Q4K-2M9X
 *
 * MOCK_SETUP=fresh starts at step 1; MOCK_LATENCY=<ms> delays every response.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
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
  role: { code: string; name: string };
  hidden: Set<string>;
}

export interface MockOptions {
  setup?: 'fresh' | 'finished';
  latencyMs?: number;
  badges?: boolean;
}

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

const STEP_DEFS: Array<[string, string, boolean]> = [
  ['welcome', 'Chào mừng', true],
  ['owner', 'Tài khoản Owner', true],
  ['org', 'Tổ chức & xưng hô', true],
  ['brain', 'Bộ não AI', true],
  ['channels', 'Kết nối kênh', true],
  ['groups', 'Chọn nhóm lắng nghe', true],
  ['refinery', 'Sàng lọc dữ liệu', true],
  ['agent', 'Agent đầu tiên', true],
  ['autonomy', 'Tự trị & ranh giới', true],
  ['team', 'Mời đội ngũ', false],
  ['backup', 'Sao lưu', false],
  ['finish', 'Hoàn tất', true],
];

function createMockState(opts: MockOptions = {}) {
  const latency = opts.latencyMs ?? Number(process.env.MOCK_LATENCY ?? 0);
  const users: User[] = [];
  const addOwner = (email = MOCK_OWNER.email, password = MOCK_OWNER.password, pin = MOCK_OWNER.pin, name = 'Anh Cơ La (Ryan)') =>
    users.push({
      id: randomUUID(),
      email,
      password,
      pin,
      display_name: name,
      role: { code: 'owner', name: 'Owner — Sếp' },
      hidden: new Set(),
    });

  const setup: SetupState & { org: { name: string; timezone: string; currency: string }; addressing: { self: string; bot_calls_me: string } } = {
    finished: opts.setup !== 'fresh',
    current_step: opts.setup === 'fresh' ? 1 : 12,
    steps: STEP_DEFS.map(([key, title, required], i) => ({
      n: i + 1,
      key,
      title,
      required,
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
      hidden: new Set(['people', 'care', 'identity', 'api', 'mcp', 'plugins', 'system']),
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
    if (body === undefined) {
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
      permissions: { 'overview.read': 'all', 'people_review.read': user.role.code === 'owner' ? 'all' : 'none' },
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
      if (setup.finished) return problem(res, 409, 'CONFLICT', 'Thiết lập đã hoàn tất');
      const skip = /^\/setup\/steps\/(\d+)\/skip$/.exec(path);
      if (skip && method === 'POST') {
        const n = Number(skip[1]);
        const step = setup.steps[n - 1];
        if (!step || step.required) return problem(res, 409, 'CONFLICT', 'Bước này bắt buộc');
        advance(n, 'skipped');
        return reply(200, stateView());
      }
      const m = /^\/setup\/steps\/(\d)$/.exec(path);
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
        return problem(res, 423, 'PIN_LOCKED', 'PIN bị khoá', { detail: { locked_until: lockedUntil } });
      }
      if (body.pin !== user.pin) {
        f.count += 1;
        if (f.count >= 5) {
          f.lockedUntil = Date.now() + 15 * 60_000;
          f.count = 0;
          pinFails.set(user.id, f);
          return problem(res, 423, 'PIN_LOCKED', 'PIN bị khoá', { detail: { locked_until: new Date(f.lockedUntil).toISOString() } });
        }
        pinFails.set(user.id, f);
        return problem(res, 401, 'PIN_INVALID', 'PIN không đúng', { attempts_left: 5 - f.count });
      }
      pinFails.delete(user.id);
      session.pinUntil = Date.now() + 30 * 60_000;
      return reply(200, { pin_verified_until: new Date(session.pinUntil).toISOString() });
    }
    const needPin = () => !session.pinUntil || session.pinUntil < Date.now();

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
    if (path === '/audit' && method === 'GET') return reply(200, { items: [], next_cursor: null });
    if (path === '/audit/verify' && method === 'GET') return reply(200, { ok: true, checked: 0, broken_at: null });

    return problem(res, 404, 'NOT_FOUND', 'Không tồn tại');
  };

  return { middleware, setup, users, sessions };
}

/**
 * Mock API with a test-only reset hook:
 * `POST /api/v1/__mock/reset {"setup":"fresh"|"finished"}` rebuilds the state.
 */
export function createMockApi(opts: MockOptions = {}) {
  let current = createMockState(opts);
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    if (req.url?.startsWith('/api/v1/__mock/reset') && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: MockOptions = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as MockOptions;
      } catch {
        body = {};
      }
      current = createMockState({ ...opts, ...body });
      res.writeHead(204);
      res.end();
      return;
    }
    return current.middleware(req, res, next);
  };
  return {
    middleware,
    get state() {
      return current;
    },
  };
}

