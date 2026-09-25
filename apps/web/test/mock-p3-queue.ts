/**
 * Mock API giai đoạn 3 · Hàng đợi & Hành động (docs/api/phase-3-queue.md): Tổng quan, Hộp thư ý nghĩa,
 * Việc & Nhắc hẹn. `handle` trả true khi đã trả lời request. Dữ liệu mẫu lấy từ docs/design/seed-data.json
 * (meaningItems, queue, spotlight, signals, kpis) đúng cách mock-p3-core.ts đã làm cho cụm nền chung.
 *
 * Bàn làm việc (giao diện duyệt) đã có đủ ở mock-p3-core.ts (`/drafts`) — cụm này không lặp lại.
 */
import type {
  GroupRef,
  InboxDetail,
  InboxItem,
  InboxTab,
  Overview,
  PersonRef,
  Promise as PromiseItem,
  Task,
} from '@gen-harness/contracts';
import { BAO, GROUP_TP, registerExplain } from './mock-p3-core';
import type { P2Ctx } from './mock-phase2';

export interface P3Options {
  fresh: boolean;
  emit: (type: string, data: unknown) => void;
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const inMin = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

// ─── đối tượng dùng chung ───────────────────────────────────────────────────
const GROUP_GO: GroupRef = { id: 'g-nganhgo', code: 'GRP-ZL-0231', name: 'Group Ngành gỗ Miền Nam', channel: 'zalo' };
const GROUP_NS: GroupRef = { id: 'g-nhansu', code: 'GRP-ZL-0356', name: 'Group Nhân sự Logistics Miền Nam', channel: 'zalo' };
const HA: PersonRef = { id: 'p-ha', code: 'PER-0007', name: 'Nguyễn Thu Hà', type: 'staff', org_name: null };
const CANDIDATE: PersonRef = { id: 'p-sang', code: 'PER-0733', name: 'Bùi Ngọc Anh', type: 'candidate', org_name: null };
const KHANG: PersonRef = { id: 'p-khang', code: 'PER-0402', name: 'Lê Minh Tâm', type: 'customer', org_name: 'An Khang Logistics' };

interface InboxRow extends InboxItem {
  units?: InboxDetail['units'];
  status?: string;
  kind?: string;
}

function seedInboxItems(): InboxRow[] {
  return [
    {
      id: 'iq-opp-1', code: 'OPP-1842', item_type: 'unit', tab: 'opportunity',
      title: 'Hỏi giá', summary: 'Xưởng gỗ Bình Dương cần 3 container ván MDF loại E1, giao trong tháng 10.',
      priority: 'P1', created_at: ago(18), score: 0.91, confidence_band: 'cao',
      subject: GROUP_GO, group: GROUP_GO, agent: null,
      alert_type: null, alert_type_label: null, suggested_action: 'Nhận và ráp khớp nhà cung cấp',
    },
    {
      id: 'iq-alert-1', code: 'ALR-0233', item_type: 'alert', tab: 'alert',
      title: 'Khách đang lạnh / sắp mất', summary: 'Khách nhắn ba lần chưa ai trả lời, thái độ đã chuyển sang gay gắt.',
      priority: 'P1', created_at: ago(134), score: null, confidence_band: null,
      subject: BAO, group: GROUP_TP, agent: null,
      alert_type: 'customer_cooling', alert_type_label: 'Khách đang lạnh / sắp mất',
      suggested_action: 'Mở hồ sơ và gán người xử lý',
      status: 'open',
    },
    {
      id: 'draft-ACT-0231', code: 'ACT-0231', item_type: 'draft', tab: 'approval',
      title: 'Báo giá', summary: 'Bản nháp báo giá 84.000.000 ₫ cho hợp đồng in ấn quý 4 đã soạn xong.',
      priority: 'P1', created_at: ago(47), score: null, confidence_band: null,
      subject: BAO, group: GROUP_TP, agent: { id: 'agent-tls', name: 'Trợ lý thương mại' },
      alert_type: null, alert_type_label: null, suggested_action: 'Xem bản nháp và duyệt',
      status: 'pending', kind: 'quotation',
    },
    {
      id: 'iq-alert-2', code: 'ALR-0234', item_type: 'alert', tab: 'alert',
      title: 'Phản hồi chậm bất thường', summary: 'Nguyễn Thu Hà phản hồi chậm bất thường ba ngày liên tiếp.',
      priority: 'P2', created_at: ago(300), score: null, confidence_band: null,
      subject: HA, group: null, agent: null,
      alert_type: 'slow_response', alert_type_label: 'Phản hồi chậm bất thường',
      suggested_action: 'Xem chứng cứ và đề xuất coaching',
      status: 'open',
    },
    {
      id: 'iq-cand-1', code: 'OPP-1839', item_type: 'unit', tab: 'candidate',
      title: 'RequestedPartnership', summary: 'Một người trong group khớp vị trí Key Account đang trống của Ban Kinh doanh.',
      priority: 'P2', created_at: ago(360), score: 0.74, confidence_band: 'thấp',
      subject: CANDIDATE, group: GROUP_NS, agent: null,
      alert_type: null, alert_type_label: null, suggested_action: 'Mở hồ sơ ứng viên',
    },
    {
      id: 'iq-reply-1', code: null, item_type: 'unit', tab: 'reply',
      title: 'Than phiền', summary: 'Khách hỏi lại tiến độ giao hàng lần thứ hai trong tuần.',
      priority: 'P2', created_at: ago(52), score: 0.82, confidence_band: 'cao',
      subject: KHANG, group: null, agent: null,
      alert_type: null, alert_type_label: null, suggested_action: 'Soạn phản hồi tiến độ giao hàng',
    },
    {
      id: 'iq-reply-2', code: null, item_type: 'unit', tab: 'reply',
      title: 'Đã gửi báo giá', summary: 'Báo giá đã gửi cho An Khang Logistics, chưa có phản hồi sau 2 ngày.',
      priority: 'P3', created_at: ago(180), score: 0.68, confidence_band: 'trung bình',
      subject: KHANG, group: null, agent: null,
      alert_type: null, alert_type_label: null, suggested_action: 'Soạn tin nhắc lại báo giá',
    },
    {
      id: 'iq-opp-2', code: null, item_type: 'unit', tab: 'opportunity',
      title: 'Chào bán', summary: 'Một nhà cung cấp mới chào giá ván ép rẻ hơn 6% trong nhóm ngành gỗ.',
      priority: 'P3', created_at: ago(210), score: 0.58, confidence_band: 'trung bình',
      subject: GROUP_GO, group: GROUP_GO, agent: null,
      alert_type: null, alert_type_label: null, suggested_action: 'Đối chiếu với nhà cung cấp hiện tại',
    },
    {
      id: 'draft-ACT-0234', code: 'ACT-0234', item_type: 'draft', tab: 'approval',
      title: 'Hợp đồng', summary: 'Biên bản đàm phán tuyến lạnh An Khang vòng ba đã soạn xong.',
      priority: 'P2', created_at: ago(120), score: null, confidence_band: null,
      subject: KHANG, group: null, agent: { id: 'agent-hc', name: 'Admin hậu cần' },
      alert_type: null, alert_type_label: null, suggested_action: 'Xem bản nháp và duyệt',
      status: 'pending', kind: 'contract',
    },
  ];
}

function seedTasks(): Task[] {
  return [
    {
      id: 't-412', code: 'TSK-0412', title: 'Lịch giao ban thứ Hai chưa có nội dung, hệ thống đã soạn nháp',
      priority: 'P3', status: 'todo', assignee: { id: 'u-me', name: 'Nhóm Điều hành' },
      subject: null, due_at: inMin(24 * 60), remind_at: null, overdue: false,
      source: 'manual', created_at: ago(24 * 60), completed_at: null,
    },
    {
      id: 't-410', code: 'TSK-0410', title: 'Gửi hợp đồng in ấn quý 4 đã ký cho Thành Phát',
      priority: 'P1', status: 'doing', assignee: { id: 'u-me', name: 'Anh Cơ La (Ryan)' },
      subject: BAO, due_at: ago(90), remind_at: null, overdue: true,
      source: 'draft', created_at: ago(300), completed_at: null,
    },
    {
      id: 't-408', code: 'TSK-0408', title: 'Theo dõi phản hồi báo giá An Khang Logistics',
      priority: 'P2', status: 'todo', assignee: null,
      subject: KHANG, due_at: inMin(120), remind_at: inMin(60), overdue: false,
      source: 'promise', created_at: ago(600), completed_at: null,
    },
    {
      id: 't-406', code: 'TSK-0406', title: 'Đã gọi xác nhận đơn hàng với Thành Phát',
      priority: 'P3', status: 'done', assignee: { id: 'u-me', name: 'Anh Cơ La (Ryan)' },
      subject: BAO, due_at: ago(1440), remind_at: null, overdue: false,
      source: 'manual', created_at: ago(2000), completed_at: ago(1000),
    },
  ];
}

function seedPromises(): PromiseItem[] {
  return [
    {
      id: 'pr-1', text: 'Gửi mẫu vải trước thứ Sáu cho Thành Phát', due_at: inMin(60 * 20), kept_at: null, broken: false,
      from: BAO, to: null, evidence: { type: 'meaning_unit', id: 'mu-1' },
    },
    {
      id: 'pr-2', text: 'Gọi lại xác nhận giá cho An Khang trong hôm nay', due_at: ago(180), kept_at: null, broken: true,
      from: KHANG, to: null, evidence: { type: 'meaning_unit', id: 'mu-2' },
    },
    {
      id: 'pr-3', text: 'Phản hồi hồ sơ ứng viên trong tuần này', due_at: ago(2000), kept_at: ago(500), broken: false,
      from: CANDIDATE, to: null, evidence: null,
    },
  ];
}

interface KpiSeed {
  key: string;
  label: string;
  value: number;
  unit: string | null;
  screen: string;
  sublabel?: string;
  filters?: Record<string, string>;
}
const KPI_ROW1: KpiSeed[] = [
  { key: 'channels_live', label: 'Kênh sống', value: 4, unit: null, screen: 'system' },
  { key: 'groups_listening', label: 'Nhóm đang lắng nghe', value: 42, unit: null, screen: 'directory' },
  { key: 'events_today', label: 'Sự kiện / ngày', value: 3184, unit: null, screen: 'raw' },
  { key: 'plugins_health', label: 'Plugin lành mạnh', value: 9, unit: null, screen: 'plugins', sublabel: 'suy giảm 2 · cách ly 0' },
  { key: 'processing_latency', label: 'Độ trễ xử lý', value: 1.2, unit: 'giây', screen: 'rules' },
  { key: 'pending_ratio', label: 'Tỉ lệ chờ duyệt', value: 42.9, unit: '%', screen: 'workbench', filters: { status: 'pending' } },
];
const KPI_ROW2: KpiSeed[] = [
  { key: 'time_to_contact', label: 'Tín hiệu → tiếp cận (trung vị)', value: 18.4, unit: 'phút', screen: 'opportunity' },
  { key: 'quotations_sent', label: 'Báo giá đã gửi (30 ngày)', value: 24, unit: null, screen: 'workbench', filters: { kind: 'quotation' } },
  { key: 'opportunity_claim_rate', label: 'Tỉ lệ cơ hội được nhận', value: 71.4, unit: '%', screen: 'opportunity', filters: { owner: 'none' } },
  { key: 'chassis_latency', label: 'Độ trễ xử lý chassis', value: 1.2, unit: 'giây', screen: 'rules' },
  { key: 'active_profiles', label: 'Hồ sơ active (30 ngày)', value: 214, unit: null, screen: 'directory' },
];

function overviewPayload(items: InboxRow[], silenced: Set<string>, tasks: Task[]): Overview {
  const visible = items.filter((i) => !silenced.has(i.id));
  const queue = [
    ...visible
      .filter((i) => i.item_type === 'alert' || i.item_type === 'draft' || i.tab === 'opportunity')
      .sort((a, b) => (a.priority < b.priority ? -1 : 1))
      .slice(0, 20)
      .map((i) => ({
        kind: (i.item_type === 'alert' ? 'alert' : i.item_type === 'draft' ? 'draft' : 'opportunity') as
          | 'alert'
          | 'draft'
          | 'opportunity',
        id: i.id, code: i.code, title: i.item_type === 'unit' ? (i.summary ?? i.title) : i.title,
        priority: i.priority, at: i.created_at, due_at: null as string | null,
      })),
    ...tasks
      .filter((t) => t.status !== 'done' && t.status !== 'cancelled' && t.due_at)
      .slice(0, 20)
      .map((t) => ({ kind: 'due' as const, id: t.id, code: t.code, title: t.title, priority: t.priority, at: null, due_at: t.due_at })),
  ];
  return {
    kpis: [
      ...KPI_ROW1.map((k) => ({
        key: k.key, label: k.label, value: k.value, unit: k.unit, row: 1 as const, status: 'ok' as const,
        sublabel: k.sublabel ?? null, pct: null,
        filter: { screen: k.screen, filters: k.filters ?? {} },
      })),
      ...KPI_ROW2.map((k) => ({
        key: k.key, label: k.label, value: k.value, unit: k.unit, row: 2 as const, status: 'ok' as const,
        sublabel: k.sublabel ?? null, pct: null,
        filter: { screen: k.screen, filters: k.filters ?? {} },
      })),
    ],
    queue,
    spotlight: [
      { person: { id: 'p-xg', code: 'PER-0201', name: 'Xưởng gỗ Bình Dương', type: 'customer', org_name: null }, dimension: 'heat', value: 91, at: ago(18) },
      { person: BAO, dimension: 'churn_risk', value: 87, at: ago(134) },
      { person: HA, dimension: 'churn_risk', value: 62, at: ago(300) },
      { person: { id: 'p-mk', code: 'PER-1002', name: 'Trần Minh Khoa', type: 'staff', org_name: null }, dimension: 'heat', value: 71, at: ago(400) },
      { person: KHANG, dimension: 'heat', value: 78, at: ago(210) },
    ],
    signals: [
      { topic: 'Giá ván MDF và gỗ công nghiệp', count: 34, delta_pct: 142 },
      { topic: 'Tìm đối tác vận chuyển lạnh', count: 19, delta_pct: 64 },
      { topic: 'Than phiền chậm giao hàng', count: 14, delta_pct: 38 },
      { topic: 'Tuyển Key Account ngành logistics', count: 8, delta_pct: 21 },
      { topic: 'Đối thủ Minh Long xuất hiện', count: 5, delta_pct: 18 },
    ],
    health: {
      channels: [
        { type: 'zalo', active: 1 },
        { type: 'whatsapp', active: 0 },
      ],
      plugins: { healthy: 9, degraded: 2, isolated: 0 },
      backlog_pending: 3,
    },
    dataQuality: { missing_identity_pct: 12, low_confidence_score_pct: 9, unassigned_event_pct: 4 },
    hourly: Array.from({ length: 24 }, (_, h) => ({
      hour: String(h).padStart(2, '0') + ':00',
      count: [15, 7, 4, 4, 7, 22, 67, 126, 229, 289, 311, 263, 178, 244, 340, 326, 274, 215, 152, 107, 81, 59, 41, 26][h],
    })),
  };
}

export function createMock(opts: P3Options) {
  let items: InboxRow[] = opts.fresh ? [] : seedInboxItems();
  let tasks: Task[] = opts.fresh ? [] : seedTasks();
  let promises: PromiseItem[] = opts.fresh ? [] : seedPromises();
  const silenced = new Map<string, { reason: string | null; until: string | null }>();
  const has = (ctx: P2Ctx, perm: string) => !!ctx.perms[perm] && ctx.perms[perm] !== 'none';

  registerExplain('task', (id) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return null;
    return {
      kind: 'task', id, title: `${t.code} · ${t.title}`, statement: 'Việc do Sếp tạo hoặc sinh từ lời hứa/bản nháp',
      method: 'manual', factors: [], units: [], history: [],
    };
  });

  function activeSilenced(): Set<string> {
    const now = Date.now();
    const s = new Set<string>();
    for (const [id, v] of silenced) if (!v.until || new Date(v.until).getTime() > now) s.add(id);
    return s;
  }

  function counts(rows: InboxRow[]): Record<InboxTab, number> {
    const out = { all: rows.length, opportunity: 0, alert: 0, approval: 0, reply: 0, candidate: 0 };
    for (const r of rows) out[r.tab] += 1;
    return out;
  }

  function taskVisible(t: Task): Task {
    const overdue = !!t.due_at && t.status !== 'done' && t.status !== 'cancelled' && new Date(t.due_at).getTime() < Date.now();
    return { ...t, overdue };
  }

  function handle(ctx: P2Ctx): boolean {
    const { method: m, path: p, url, body, reply, problem } = ctx;
    const seg = p.split('/').filter(Boolean);

    if (p === '/overview' && m === 'GET') {
      if (!has(ctx, 'overview.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      return reply(200, overviewPayload(items, activeSilenced(), tasks));
    }

    if (seg[0] === 'inbox') {
      if (!has(ctx, 'queue.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      const visible = items.filter((i) => !activeSilenced().has(i.id));
      if (seg.length === 1 && m === 'GET') {
        const tab = (url.searchParams.get('tab') ?? 'all') as InboxTab;
        const intent = url.searchParams.get('intent');
        const cnt = counts(visible);
        let rows = visible;
        if (tab !== 'all') rows = rows.filter((r) => r.tab === tab);
        if (intent) rows = rows.filter((r) => r.item_type === 'unit' && r.title === intent);
        return reply(200, {
          items: rows.map(({ units: _u, ...rest }) => rest),
          next_cursor: null,
          total: cnt.all,
          counts: cnt,
        });
      }
      const row = visible.find((i) => i.id === seg[1]);
      if (seg.length === 2 && m === 'GET') {
        if (!row) return problem(404, 'NOT_FOUND', 'Mục trong hàng đợi không tồn tại hoặc ngoài phạm vi của bạn');
        return reply(200, { ...row, units: row.units ?? [] });
      }
      if (seg.length === 3 && m === 'POST') {
        if (!has(ctx, 'queue.act')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        if (!row) return problem(404, 'NOT_FOUND', 'Mục trong hàng đợi không tồn tại hoặc ngoài phạm vi của bạn');
        const action = seg[2];
        if (action === 'act') {
          if (row.item_type === 'draft') return problem(409, 'USE_WORKBENCH', 'Duyệt bản nháp này ở Bàn làm việc');
          if (row.item_type === 'alert') {
            if (row.status !== 'open') return problem(409, 'ALERT_DECIDED', 'Cảnh báo này đã được xử lý');
            row.status = 'acknowledged';
            const b = body as { create_task?: boolean };
            if (b.create_task) {
              const t: Task = {
                id: `t-from-${row.id}`, code: `TSK-0${400 + tasks.length}`, title: row.title, priority: row.priority,
                status: 'todo', assignee: null, subject: row.subject, due_at: null, remind_at: null, overdue: false,
                source: 'promise', created_at: new Date().toISOString(), completed_at: null,
              };
              tasks = [t, ...tasks];
            }
            return reply(200, { ok: true, status: 'acknowledged' });
          }
          const b = body as { text?: string };
          if (!b.text?.trim()) return problem(422, 'VALIDATION', 'Cần nội dung để soạn trả lời', { errors: { text: 'Không được để trống' } });
          const draft = { id: `draft-from-${row.id}`, code: `ACT-0${240 + items.length}`, status: 'pending' };
          opts.emit('draft.new', {
            id: draft.id, code: draft.code, kind: 'message', kind_label: 'Tin nhắn', title: `Trả lời ${row.title}`,
            agent: null, created_by: { id: 'u-me', name: ctx.userLabel }, created_at: new Date().toISOString(),
            status: 'pending', hold_reason: null, subject: row.subject,
          });
          return reply(200, { ok: true, draft });
        }
        if (action === 'assign') {
          const b = body as { user_id: string };
          return reply(200, { ok: true, assigned_to: { id: b.user_id, name: 'Chị Lan Phạm' } });
        }
        if (action === 'silence') {
          const b = body as { reason?: string | null; until?: string | null };
          silenced.set(row.id, { reason: b.reason ?? null, until: b.until ?? null });
          return reply(200, { ok: true });
        }
      }
    }

    if (seg[0] === 'tasks') {
      if (seg[1] === 'promises') {
        if (!has(ctx, 'queue.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        if (seg.length === 2 && m === 'GET') {
          const status = url.searchParams.get('status') ?? 'upcoming';
          const now = Date.now();
          let rows = promises;
          if (status === 'upcoming') rows = rows.filter((p) => !p.kept_at && new Date(p.due_at).getTime() >= now && new Date(p.due_at).getTime() < now + 3 * 86_400_000);
          else if (status === 'overdue') rows = rows.filter((p) => !p.kept_at && new Date(p.due_at).getTime() < now);
          else if (status === 'kept') rows = rows.filter((p) => !!p.kept_at);
          return reply(200, { items: rows, next_cursor: null, total: rows.length });
        }
        if (seg.length === 3 && m === 'PATCH') {
          if (!has(ctx, 'queue.act')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
          const pr = promises.find((x) => x.id === seg[2]);
          if (!pr) return problem(404, 'NOT_FOUND', 'Lời hứa không tồn tại hoặc ngoài phạm vi của bạn');
          const kept = (body as { kept: boolean }).kept;
          promises = promises.map((x) => (x.id === pr.id ? { ...x, kept_at: kept ? new Date().toISOString() : null, broken: !kept } : x));
          return reply(200, { ok: true });
        }
        return false;
      }
      if (!has(ctx, 'queue.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      if (seg.length === 1 && m === 'GET') {
        const status = url.searchParams.get('status');
        const priority = url.searchParams.get('priority');
        const overdue = url.searchParams.get('overdue');
        const assignee = url.searchParams.get('assignee_user_id');
        let rows = tasks.map(taskVisible);
        if (status) rows = rows.filter((t) => t.status === status);
        if (priority) rows = rows.filter((t) => t.priority === priority);
        if (overdue === 'true') rows = rows.filter((t) => t.overdue);
        if (assignee) rows = rows.filter((t) => t.assignee?.id === assignee);
        return reply(200, { items: rows, next_cursor: null, total: rows.length });
      }
      if (seg.length === 1 && m === 'POST') {
        if (!has(ctx, 'queue.act')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        const b = body as { title: string; priority?: Task['priority']; assignee_user_id?: string; subject?: { type: 'person' | 'group'; id: string }; due_at?: string | null; remind_at?: string | null };
        if (!b.title?.trim()) return problem(422, 'VALIDATION', 'Cần tiêu đề việc', { errors: { title: 'Không được để trống' } });
        const t: Task = {
          id: `t-new-${Date.now()}`, code: `TSK-0${400 + tasks.length}`, title: b.title, priority: b.priority ?? 'P3',
          status: 'todo', assignee: b.assignee_user_id ? { id: b.assignee_user_id, name: 'Chị Lan Phạm' } : null,
          subject: null, due_at: b.due_at ?? null, remind_at: b.remind_at ?? null, overdue: false,
          source: 'manual', created_at: new Date().toISOString(), completed_at: null,
        };
        tasks = [t, ...tasks];
        return reply(201, taskVisible(t));
      }
      const t = tasks.find((x) => x.id === seg[1]);
      if (seg.length === 2 && m === 'GET') {
        if (!t) return problem(404, 'NOT_FOUND', 'Việc không tồn tại hoặc ngoài phạm vi của bạn');
        return reply(200, taskVisible(t));
      }
      if (seg.length === 2 && m === 'PATCH') {
        if (!has(ctx, 'queue.act')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        if (!t) return problem(404, 'NOT_FOUND', 'Việc không tồn tại hoặc ngoài phạm vi của bạn');
        const b = body as Partial<{ status: Task['status']; priority: Task['priority']; assignee_user_id: string | null; due_at: string | null; remind_at: string | null }>;
        if (b.status !== undefined) {
          t.status = b.status;
          t.completed_at = b.status === 'done' ? new Date().toISOString() : t.completed_at;
        }
        if (b.priority !== undefined) t.priority = b.priority;
        if ('assignee_user_id' in b) t.assignee = b.assignee_user_id ? { id: b.assignee_user_id, name: 'Chị Lan Phạm' } : null;
        if (b.due_at !== undefined) t.due_at = b.due_at;
        if (b.remind_at !== undefined) t.remind_at = b.remind_at;
        return reply(200, taskVisible(t));
      }
    }

    return false;
  }

  return {
    handle,
    hooks: {
      /** Test: bơm thêm một cảnh báo mới vào hàng đợi. */
      alert: (row: Partial<InboxRow> = {}) => {
        const a: InboxRow = {
          id: `iq-alert-hook-${Date.now()}`, code: `ALR-0${300 + items.length}`, item_type: 'alert', tab: 'alert',
          title: 'Khách đang lạnh / sắp mất', summary: 'Cảnh báo mới bơm qua hook thử nghiệm.',
          priority: 'P1', created_at: new Date().toISOString(), score: null, confidence_band: null,
          subject: BAO, group: GROUP_TP, agent: null, alert_type: 'customer_cooling',
          alert_type_label: 'Khách đang lạnh / sắp mất', suggested_action: 'Mở hồ sơ và gán người xử lý',
          status: 'open', ...row,
        };
        items = [a, ...items];
        opts.emit('alert.new', {});
        return a;
      },
      items: () => items,
      tasks: () => tasks,
      promises: () => promises,
      setTasks: (rows: Task[]) => {
        tasks = rows;
      },
    } as Record<string, (...args: never[]) => unknown>,
    dispose: () => {},
  };
}
