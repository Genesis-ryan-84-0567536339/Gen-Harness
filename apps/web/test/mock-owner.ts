/**
 * Mock v0.1.55 (G5) — Mặt tiền Owner (`/api/v1/owner/*`, CHỈ ĐỌC), theo HỢP ĐỒNG của `apps/api/gh/owner/routes.py`:
 *
 * - `GET /owner/today` → {needs_review (≤ 10), kpis, briefing_latest, filter_value, suggestions, progress}.
 * - `GET /owner/relations?list=hot|cooling|bridges|matches&limit=20` → {list, items:[{id,name,subtitle,metric_text,to}]}; `list` lạ ⇒
 *   422 VALIDATION; `limit` bị chặn trong [1, 50] (không lỗi).
 * - `GET /owner/tasks` → {groups:[{key: inbox|desk|tasks, title, count, to, items ≤ 5}]}.
 * - CHỈ Owner: vai trò khác 403 FORBIDDEN. Không có POST/PUT/PATCH/DELETE (405 NOT_ALLOWED).
 *
 * Dữ liệu dùng đúng mã người của `mock-p3-relations` (p-hau, p-bao…) nên bấm một dòng mở được Hồ sơ sống của mock.
 *
 * Hook e2e `POST /api/v1/__mock/p3/owner/{hook}`:
 *   scenario {mode: 'data'|'empty'|'error', only?: 'today'|'relations'|'tasks'} — kịch bản dữ liệu / rỗng / lỗi 500 (mặc định áp cho
 *                                  cả ba; `only` chỉ áp cho một đường, các đường còn lại về 'data');
 *   state {} — đọc số lần gọi + lời gọi bị 403 của vai trò khác Owner (kiểm tra); reset {} — về dữ liệu mẫu.
 *
 * Nối vào `phase3` của `test/mock-api.ts`, TRƯỚC `core`:
 *   `import { createMock as createOwner } from './mock-owner';` và
 *   `owner: createOwner({ fresh: opts.setup === 'fresh', emit: broadcast, boss: bossChecks.hooks.overview as () => BossOverview }),`.
 */
import type {
  OwnerRelationList,
  OwnerRelationRow,
  OwnerRelations,
  OwnerTasks,
  OwnerToday,
} from '../../../packages/contracts/src/owner';
import type { BossOverview } from '../../../packages/contracts/src/bossChecks';
import type { P2Ctx } from './mock-phase2';

interface Opts {
  fresh: boolean;
  emit: (type: string, data: unknown) => void;
  /** Bảng "Việc Sếp cần làm" hiện tại — `progress` lấy từ đây (không ghi cứng); thiếu thì dùng 2/6. */
  boss?: () => BossOverview;
}

type Mode = 'data' | 'empty' | 'error';
type Endpoint = 'today' | 'relations' | 'tasks';

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const row = (id: string, name: string, subtitle: string, metric: string, to = `/profile?id=${id}`): OwnerRelationRow => ({
  id,
  name,
  subtitle,
  metric_text: metric,
  to,
});

function relationItems(list: OwnerRelationList): OwnerRelationRow[] {
  switch (list) {
    case 'hot':
      return [
        row('p-hau', 'Trần Văn Hậu', 'Khách hàng · Xưởng gỗ Bình Dương', 'Độ nóng 91 · đang tăng'),
        row('p-bao', 'Nguyễn Văn Bảo', 'Khách hàng · Công ty in Thành Phát', 'Độ nóng 87'),
        row('p-duoc', 'Lâm Văn Được', 'Nhà cung cấp · Kho ván Bình Dương', 'Độ nóng 84'),
      ];
    case 'cooling':
      return [
        row('rel-1', 'Hoàng Thị Lan và Phạm Quốc Minh', 'Hay trao đổi về MDF E1', '42 ngày chưa liên lạc', '/profile?id=p-lan'),
        row('rel-2', 'Đặng Hữu Trí và Trịnh Mỹ Duyên', 'Hay trao đổi cùng nhóm', '35 ngày chưa liên lạc', '/profile?id=p-tri'),
      ];
    case 'bridges':
      return [
        row('p-khoa', 'Trần Minh Khoa', 'Có mặt ở 3 nhóm · Nhân viên', 'Nối 5 cặp nhóm'),
        row('p-thang', 'Bùi Đức Thắng', 'Có mặt ở 2 nhóm · Khách hàng · Gỗ Trường Thành Mới', 'Nối 2 cặp nhóm'),
      ];
    default:
      return [row('m-1', 'Ván MDF E1 17mm ↔ Ván MDF E1 17mm', 'Bùi Đức Thắng cần · Lâm Văn Được có', 'Khớp 88%', '/profile?id=p-thang')];
  }
}

const REQUIRED_TOTAL_DEFAULT = 6;

export function createMock(opts: Opts) {
  const state = {
    mode: { today: 'data', relations: 'data', tasks: 'data' } as Record<Endpoint, Mode>,
    calls: { today: 0, relations: 0, tasks: 0 } as Record<Endpoint, number>,
    nonOwnerCalls: [] as string[],
  };

  const progress = () => {
    const o = opts.boss?.();
    return o ? { required_done: o.required_done, required_total: o.required_total } : { required_done: 2, required_total: REQUIRED_TOTAL_DEFAULT };
  };

  function today(mode: Mode): OwnerToday {
    if (mode === 'empty') {
      return {
        needs_review: [],
        kpis: { hot: 0, cooling: 0, open_opps: 0, open_value_vnd: 0, overdue_promises: 0 },
        briefing_latest: null,
        filter_value: { filtered: 0, spam_blocked: 0, calls_saved: 0, jev_on: false },
        suggestions: [],
        progress: progress(),
      };
    }
    return {
      needs_review: [
        { kind: 'proposal', title: 'Gen đề xuất: Soạn nháp tin gửi đi (cần mã PIN)', to: '/owner/gen', at: ago(12 * MIN) },
        { kind: 'draft', title: 'Trả lời anh Hậu về giá ván MDF', to: '/workbench?id=draft-1', at: ago(35 * MIN) },
        { kind: 'draft', title: 'Báo giá chờ duyệt', to: '/workbench?id=draft-2', at: ago(3 * 60 * MIN) },
        { kind: 'overdue_task', title: 'Gọi lại chị Lan về hợp đồng', to: '/tasks?overdue=true', at: ago(2 * 24 * 60 * MIN) },
      ],
      kpis: { hot: 3, cooling: 2, open_opps: 12, open_value_vnd: 2_400_000_000, overdue_promises: 1 },
      briefing_latest: {
        title: 'Bản tin Gen · sáng 10/10',
        at: ago(3 * 60 * MIN),
        summary_text: 'Sáng nay có 3 bản nháp chờ Sếp duyệt và 2 mối quan hệ đang nguội dần.',
        to: '/owner/gen',
      },
      filter_value: { filtered: 128, spam_blocked: 31, calls_saved: 94, jev_on: true },
      suggestions: [
        {
          key: 'apply_standard',
          title: 'Dùng cấu hình chuẩn cho Gen',
          body: 'Em đề xuất áp cấu hình chuẩn theo vai để Gen chạy ổn định hơn — Sếp xem lại rồi bấm áp dụng.',
          to: '/system?tab=brain#chuan',
        },
        {
          key: 'background_key_missing',
          title: 'Việc nền chưa có khoá để chạy',
          body: 'Lọc tin và bản tin cần một khoá riêng để chạy ngầm. Sếp thêm khoá ở Bộ não AI nhé.',
          to: '/system?tab=brain',
        },
      ],
      progress: progress(),
    };
  }

  function tasks(mode: Mode): OwnerTasks {
    const empty = mode === 'empty';
    return {
      groups: [
        {
          key: 'inbox',
          title: 'Hộp thư đã lọc',
          count: empty ? 0 : 7,
          to: '/inbox',
          items: empty
            ? []
            : [
                { title: 'Hỏi giá: Khách hỏi MDF E1 17mm, 3 container', at: ago(20 * MIN), to: '/inbox' },
                { title: 'Than phiền: Giao hàng trễ hai ngày', at: ago(2 * 60 * MIN), to: '/inbox' },
              ],
        },
        {
          key: 'desk',
          title: 'Bàn làm việc',
          count: empty ? 0 : 3,
          to: '/workbench',
          items: empty ? [] : [{ title: 'Trả lời anh Hậu về giá ván MDF', at: ago(35 * MIN), to: '/workbench?id=draft-1' }],
        },
        {
          key: 'tasks',
          title: 'Việc & Nhắc hẹn',
          count: empty ? 0 : 5,
          to: '/tasks',
          items: empty ? [] : [{ title: 'Gọi lại chị Lan về hợp đồng', at: ago(2 * 24 * 60 * MIN), to: '/tasks' }],
        },
      ],
    };
  }

  function fail(ctx: P2Ctx, ep: Endpoint): boolean {
    return ctx.problem(500, 'INTERNAL', 'Hệ thống gặp lỗi khi xử lý yêu cầu — đã ghi nhật ký', { error_id: `ERR-OWNER-${ep.toUpperCase()}` });
  }

  function handle(ctx: P2Ctx): boolean {
    const { method: m, path: p } = ctx;
    if (p !== '/owner' && !p.startsWith('/owner/')) return false;
    if (ctx.role !== 'owner') {
      state.nonOwnerCalls.push(`${ctx.role} ${m} ${p}`);
      return ctx.problem(403, 'FORBIDDEN', 'Vai trò của bạn không có quyền thao tác này');
    }
    if (m !== 'GET') return ctx.problem(405, 'NOT_ALLOWED', 'Mặt tiền chỉ để xem — thao tác ghi đi qua luồng sẵn có');

    if (p === '/owner/today') {
      state.calls.today += 1;
      return state.mode.today === 'error' ? fail(ctx, 'today') : ctx.reply(200, today(state.mode.today));
    }
    if (p === '/owner/tasks') {
      state.calls.tasks += 1;
      return state.mode.tasks === 'error' ? fail(ctx, 'tasks') : ctx.reply(200, tasks(state.mode.tasks));
    }
    if (p === '/owner/relations') {
      state.calls.relations += 1;
      const list = ctx.url.searchParams.get('list') ?? 'hot';
      if (!['hot', 'cooling', 'bridges', 'matches'].includes(list)) {
        return ctx.problem(422, 'VALIDATION', 'Dữ liệu chưa hợp lệ', { detail: null, errors: { list: 'Chỉ nhận hot, cooling, bridges hoặc matches' } });
      }
      if (state.mode.relations === 'error') return fail(ctx, 'relations');
      const raw = Number(ctx.url.searchParams.get('limit') ?? 20);
      const limit = Math.max(1, Math.min(Number.isFinite(raw) ? Math.trunc(raw) : 20, 50));
      const items = state.mode.relations === 'empty' ? [] : relationItems(list as OwnerRelationList).slice(0, limit);
      const body: OwnerRelations = { list: list as OwnerRelationList, items };
      return ctx.reply(200, body);
    }
    return ctx.problem(404, 'NOT_FOUND', 'Không tồn tại');
  }

  const hooks = {
    scenario: (b: unknown) => {
      const x = (b ?? {}) as { mode?: Mode; only?: Endpoint };
      const mode: Mode = x.mode === 'empty' || x.mode === 'error' ? x.mode : 'data';
      const eps: Endpoint[] = x.only === 'today' || x.only === 'relations' || x.only === 'tasks' ? [x.only] : ['today', 'relations', 'tasks'];
      for (const ep of ['today', 'relations', 'tasks'] as Endpoint[]) state.mode[ep] = eps.includes(ep) ? mode : 'data';
      return { ...state.mode };
    },
    state: () => ({ mode: { ...state.mode }, calls: { ...state.calls }, nonOwnerCalls: [...state.nonOwnerCalls] }),
    reset: () => {
      state.mode = { today: 'data', relations: 'data', tasks: 'data' };
      state.calls = { today: 0, relations: 0, tasks: 0 };
      state.nonOwnerCalls = [];
      return null;
    },
  } as Record<string, (...args: never[]) => unknown>;

  return { handle, hooks, dispose: () => {} };
}
