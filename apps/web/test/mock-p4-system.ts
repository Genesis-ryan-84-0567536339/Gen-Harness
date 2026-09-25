/**
 * Mock API giai đoạn 4 · Điều khiển hệ thống (PLAN 4.5/4.6, `apps/api/gh/system_api/routes.py` +
 * `apps/api/gh/setup/routes.py`):
 *   - Quyền hạn: ma trận (`/permissions`) trên CHÍNH `MATRIX` dùng chung với `Me.permissions`
 *     (`mock-api.ts`, KHÔNG copy) — sửa ô ở màn Quyền hạn đổi luôn năng lực thật của vai trò, giống hệt
 *     `core.role_permissions` là một bảng duy nhất ở backend thật; nhóm đang lắng nghe (`/listening-groups`)
 *     trên `groups` dùng chung của `mock-phase2.ts`; ranh giới có trách nhiệm (`/boundaries*`).
 *   - Nhật ký hệ thống (`/audit-log*`) trên `audit` dùng chung của `mock-api.ts` (cùng mảng `/audit` đã dùng).
 *   - Dữ liệu & lưu trữ — spec I (`/retention-policies`, `/persons/{id}/data-requests` trên `people` dùng
 *     chung của `mock-p3-relations.ts`).
 *   - Bước thiết lập 10–11 (`step10`/`step11`, gọi thẳng từ `mock-api.ts` vì `/setup/steps/*` không đi qua
 *     `handle(ctx)` chung như các route khác — xem `mock-phase2.ts` `setupStep`).
 *
 * "Bộ não AI" (`/providers*`, `/cli/*`, `/failover-rules`, `PATCH /providers/chain`) đã có mock đủ ở
 * `mock-phase2.ts`/`mock-p4-api.ts` — màn `system` chỉ đọc lại, KHÔNG lặp ở đây.
 */
import { randomUUID } from 'node:crypto';
import type { P2Ctx } from './mock-phase2';

export type RoleCode = 'owner' | 'manager' | 'operator' | 'agent_staff' | 'auditor';

export interface AuditRow {
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

interface MockGroup {
  id: string;
  code: string;
  name: string;
  members: number;
  kind: string;
  listen_mode: string;
  view_scope: string;
  channel: string;
  raw24h: number;
}

interface MockPerson {
  id: string;
  code: string;
  name: string;
}

export interface P4SystemOptions {
  fresh: boolean;
  emit: (type: string, data: unknown) => void;
  /** `mock-phase2.ts` hooks.groups() — mảng dùng chung, KHÔNG copy. */
  getGroups: () => MockGroup[];
  /** `mock-api.ts` MATRIX — mảng dùng chung, KHÔNG copy (xem docstring đầu file). */
  matrix: Record<string, [string, string, string, string, string]>;
  roleOrder: RoleCode[];
  /** `mock-api.ts` audit — mảng dùng chung (unshift ghi mới lên đầu). */
  auditLog: AuditRow[];
  /** `mock-p3-relations.ts` hooks.people() — mảng dùng chung (erase ghi thẳng lên đây). */
  getPersons: () => MockPerson[];
}

// 7 cột ma trận thiết kế → các quyền thuộc cột đó (`gh.system_api.routes.PERMISSION_COLUMNS`, y hệt thứ tự).
const PERMISSION_COLUMNS: Array<[string, string, string[]]> = [
  ['overview', 'Tổng quan', ['overview.read']],
  ['queue', 'Hàng đợi', ['queue.read', 'queue.act']],
  ['profile', 'Hồ sơ khách', ['profile.read', 'profile.write']],
  ['people_review', 'Đánh giá nhân sự', ['people_review.read', 'people_review.write', 'care.read']],
  ['opportunity', 'Cơ hội', ['opportunity.read', 'opportunity.write']],
  ['action', 'Hành động', ['action.draft', 'action.approve']],
  ['audit', 'Nhật ký', ['audit.read']],
];
const EDITABLE_PERMISSIONS = new Set(PERMISSION_COLUMNS.flatMap(([, , codes]) => codes));
// Auditor không bao giờ có quyền ghi (`rbac.WRITE_PERMISSIONS`, khoá cứng).
const WRITE_PERMISSIONS = new Set(['queue.act', 'profile.write', 'people_review.write', 'opportunity.write', 'action.draft', 'action.approve']);

const ROLE_INFO: Record<RoleCode, { name: string; meta: string }> = {
  owner: { name: 'Owner — Sếp', meta: 'thấy toàn cảnh' },
  manager: { name: 'Manager', meta: 'thấy team mình' },
  operator: { name: 'Operator', meta: 'thấy hàng đợi việc' },
  agent_staff: { name: 'Agent nhân viên', meta: 'chỉ khách được phân' },
  auditor: { name: 'Auditor', meta: 'xem, không hành động' },
};

interface BoundaryRow {
  code: string;
  label: string;
  enabled: boolean;
  locked: boolean;
  params: Record<string, unknown>;
}

// 6/8 khoá cứng ARCHITECTURE §7.4 có dòng ở đây (`apps/api/gh/bootstrap.py` BOUNDARIES — cùng giá trị khởi
// tạo thật); 2 khoá còn lại (kho thô/nhật ký chỉ-INSERT, PIN+mã hoá bí mật) không có công tắc, hiển thị tĩnh
// ở client (`STATIC_HARD_BOUNDARIES`, `packages/contracts/src/p4-system.ts`).
function seedBoundaries(): BoundaryRow[] {
  return [
    { code: 'listen_authorized_only', label: 'Chỉ lắng nghe nhóm Owner đã bật', enabled: true, locked: true, params: {} },
    { code: 'disclose_staff_observation', label: 'Công khai nội bộ khi dùng để đánh giá nhân sự', enabled: true, locked: false, params: {} },
    { code: 'hide_sensitive_below_owner', label: 'Ẩn dữ liệu nhạy cảm khỏi vai trò dưới Owner', enabled: true, locked: true, params: {} },
    { code: 'personnel_alert_requires_evidence', label: 'Điểm số, cảnh báo nhân sự phải có chứng cứ', enabled: true, locked: true, params: {} },
    { code: 'observe_external_market', label: 'Quan sát nhóm thị trường bên ngoài', enabled: true, locked: false, params: {} },
    { code: 'auto_personnel_decisions', label: 'Hệ thống tự ra quyết định nhân sự', enabled: false, locked: true, params: {} },
    {
      code: 'approval_gate',
      label: 'Gửi ra ngoài / vượt ngưỡng tiền / liên quan nhân sự luôn chờ duyệt',
      enabled: true,
      locked: true,
      params: { approval_threshold_vnd: 50_000_000 },
    },
    { code: 'mcp_write_requires_approval', label: 'Tool MCP loại ghi qua duyệt trước khi chạy', enabled: true, locked: true, params: {} },
  ];
}

const RETENTION_DATASETS = ['raw.events', 'clean.meaning_units', 'ops.action_log', 'memory.entries', 'agent.model_calls'] as const;
type RetentionDataset = (typeof RETENTION_DATASETS)[number];
interface RetentionRow {
  keep_days: number | null;
  anonymize_after_days: number | null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const INVITE_ROLES = new Set(['manager', 'operator', 'agent_staff', 'auditor']);

export interface Step10Invited {
  id: string;
  display_name: string;
  email: string;
  role: string;
  temp_password: string;
}
export interface BackupConfig {
  frequency: 'daily' | 'weekly' | 'monthly';
  time_of_day: string;
  retention_count: number;
  destination: 'local' | 's3' | 'minio';
}
type StepResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; title: string; extra?: Record<string, unknown> };

export function createMock(opts: P4SystemOptions) {
  const has = (ctx: P2Ctx, perm: string) => !!ctx.perms[perm] && ctx.perms[perm] !== 'none';
  const pin = (ctx: P2Ctx, operation: string) => {
    if (!ctx.needPin()) return true;
    ctx.problem(423, 'PIN_REQUIRED', 'Thao tác này cần nhập mã PIN', { detail: { operation } });
    return false;
  };

  const boundaries = seedBoundaries();
  const retention = new Map<RetentionDataset, RetentionRow>(
    opts.fresh
      ? []
      : [
          ['raw.events', { keep_days: 365, anonymize_after_days: null }],
          ['clean.meaning_units', { keep_days: 730, anonymize_after_days: null }],
          ['ops.action_log', { keep_days: 2555, anonymize_after_days: null }],
          ['memory.entries', { keep_days: null, anonymize_after_days: null }],
          ['agent.model_calls', { keep_days: 90, anonymize_after_days: 30 }],
        ],
  );
  const dataRequests = new Map<string, Array<{ id: string; kind: string; status: string; requested_at: string; completed_at: string | null }>>();
  const restrictedPersons = new Set<string>();
  const backup: BackupConfig = { frequency: 'daily', time_of_day: '02:00', retention_count: 7, destination: 'local' };

  function permissionsPage() {
    const roles = opts.roleOrder.map((code) => {
      const idx = opts.roleOrder.indexOf(code);
      const permissions: Record<string, string> = {};
      for (const p of EDITABLE_PERMISSIONS) permissions[p] = opts.matrix[p]?.[idx] ?? 'none';
      return { code, name: ROLE_INFO[code].name, meta: ROLE_INFO[code].meta, permissions };
    });
    return { columns: PERMISSION_COLUMNS.map(([key, label, permissions]) => ({ key, label, permissions })), roles };
  }

  function retentionList() {
    return RETENTION_DATASETS.map((d) => ({ dataset: d, ...(retention.get(d) ?? { keep_days: null, anonymize_after_days: null }) }));
  }

  function handle(ctx: P2Ctx): boolean {
    const { method: m, path: p, url, reply, problem, body } = ctx;
    const q = url.searchParams;
    const seg = p.split('/').filter(Boolean);

    // ── Quyền hạn: ma trận ──
    if (p === '/permissions' && m === 'GET') {
      if (!has(ctx, 'system.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      return reply(200, permissionsPage());
    }
    if (p === '/permissions' && m === 'PATCH') {
      if (!has(ctx, 'roles.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      if (!pin(ctx, 'roles.change')) return true;
      const b = body as { role?: string; permission?: string; scope?: string };
      const role = String(b.role ?? '') as RoleCode;
      const permission = String(b.permission ?? '');
      const scope = String(b.scope ?? '');
      if (!EDITABLE_PERMISSIONS.has(permission)) return problem(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors: { permission: 'Quyền này không nằm trong ma trận sửa được ở Quyền hạn' } });
      if (role === 'owner' && scope !== 'all') return problem(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors: { scope: 'Owner luôn toàn quyền ở mọi cột — khoá cứng, không sửa được' } });
      if (role === 'auditor' && WRITE_PERMISSIONS.has(permission) && scope !== 'none') return problem(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors: { scope: 'Auditor không bao giờ có quyền ghi — khoá cứng, không sửa được' } });
      const idx = opts.roleOrder.indexOf(role);
      if (idx < 0 || !opts.matrix[permission]) return problem(404, 'NOT_FOUND', 'Ô ma trận');
      opts.matrix[permission][idx] = scope;
      return reply(200, permissionsPage());
    }

    // ── Quyền hạn: nhóm đang lắng nghe ──
    if (p === '/listening-groups' && m === 'GET') {
      if (!has(ctx, 'system.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      const rows = opts
        .getGroups()
        .filter((g) => g.listen_mode !== 'off')
        .map(({ raw24h, ...g }) => ({ ...g, msgs_24h: raw24h }));
      return reply(200, rows);
    }

    // ── Quyền hạn: ranh giới có trách nhiệm ──
    if (p === '/boundaries' && m === 'GET') {
      if (!has(ctx, 'system.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      return reply(200, boundaries);
    }
    if (seg[0] === 'boundaries' && seg.length === 2 && m === 'PATCH') {
      if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      if (!pin(ctx, 'policy.change')) return true;
      const row = boundaries.find((b) => b.code === seg[1]);
      if (!row) return problem(404, 'NOT_FOUND', 'Ranh giới');
      const b = body as { enabled?: boolean; params?: Record<string, unknown> };
      if (typeof b.enabled === 'boolean' && b.enabled !== row.enabled && row.locked) {
        return problem(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors: { enabled: 'Ranh giới này là khoá cứng — không tắt/bật được (ARCHITECTURE §7.4)' } });
      }
      if (row.code === 'approval_gate' && b.params && 'approval_threshold_vnd' in b.params) {
        const v = b.params.approval_threshold_vnd;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
          return problem(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors: { 'params.approval_threshold_vnd': 'Ngưỡng tiền phải là số nguyên không âm' } });
        }
      }
      if (typeof b.enabled === 'boolean') row.enabled = b.enabled;
      if (b.params) row.params = { ...row.params, ...b.params };
      return reply(200, row);
    }

    // ── Nhật ký hệ thống ──
    if (p === '/audit-log' && m === 'GET') {
      if (!has(ctx, 'audit.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      const actorType = q.get('actor_type');
      const action = q.get('action');
      const targetType = q.get('target_type');
      const targetId = q.get('target_id');
      const since = q.get('since');
      const until = q.get('until');
      const filtered = opts.auditLog.filter(
        (a) =>
          (!actorType || a.actor_type === actorType) &&
          (!action || a.action.startsWith(action)) &&
          (!targetType || a.target_type === targetType) &&
          (!targetId || a.target_id === targetId) &&
          (!since || a.at >= since) &&
          (!until || a.at <= until),
      );
      const limit = Math.min(200, Number(q.get('limit') ?? 50));
      const off = Number(q.get('cursor') ?? 0);
      const page = filtered.slice(off, off + limit);
      return reply(200, { items: page, next_cursor: off + limit < filtered.length ? String(off + limit) : null });
    }
    if (p === '/audit-log/export' && m === 'GET') {
      if (!has(ctx, 'data.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      if (!pin(ctx, 'data.export')) return true;
      const actorType = q.get('actor_type');
      const action = q.get('action');
      const rows = opts.auditLog.filter((a) => (!actorType || a.actor_type === actorType) && (!action || a.action.startsWith(action)));
      const lines = ['at,actor_type,actor_id,actor_label,action,target_type,target_id,target_label,autonomy_level,result'];
      for (const r of rows) {
        lines.push(
          [r.at, r.actor_type, r.actor_id ?? '', r.actor_label ?? '', r.action, r.target_type ?? '', r.target_id ?? '', r.target_label ?? '', r.autonomy_level ?? '', r.result].join(','),
        );
      }
      const name = `nhat-ky-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2')}.csv`;
      ctx.text(200, 'text/csv; charset=utf-8', `\uFEFF${lines.join('\n')}`, name);
      return true;
    }

    // ── Dữ liệu & lưu trữ (spec I) ──
    if (p === '/retention-policies' && m === 'GET') {
      if (!has(ctx, 'system.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      return reply(200, retentionList());
    }
    if (p === '/retention-policies' && m === 'PATCH') {
      if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
      if (!pin(ctx, 'policy.change')) return true;
      const b = body as { dataset?: string; keep_days?: number | null; anonymize_after_days?: number | null };
      const dataset = b.dataset as RetentionDataset;
      if (!RETENTION_DATASETS.includes(dataset)) return problem(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors: { dataset: 'Tập dữ liệu không hợp lệ' } });
      retention.set(dataset, { keep_days: b.keep_days ?? null, anonymize_after_days: b.anonymize_after_days ?? null });
      return reply(200, retentionList());
    }
    if (seg[0] === 'persons' && seg[2] === 'data-requests') {
      const person = opts.getPersons().find((x) => x.id === seg[1]);
      if (!person) return problem(404, 'NOT_FOUND', 'Người');
      if (seg.length === 3 && m === 'GET') {
        if (!has(ctx, 'system.read')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        return reply(200, dataRequests.get(person.id) ?? []);
      }
      if (seg.length === 3 && m === 'POST') {
        if (!has(ctx, 'system.manage')) return problem(403, 'FORBIDDEN', 'Vai trò không có quyền này');
        if (!pin(ctx, 'data.export_delete')) return true;
        const kind = String((body as { kind?: string }).kind ?? '');
        if (!['export', 'erase', 'restrict'].includes(kind)) return problem(422, 'VALIDATION_ERROR', 'Dữ liệu chưa hợp lệ', { errors: { kind: 'Loại yêu cầu không hợp lệ' } });
        const id = randomUUID();
        let result: unknown;
        if (kind === 'export') {
          result = { person: { id: person.id, code: person.code, display_name: person.name }, identities: [], scores: [], notebook: [] };
        } else if (kind === 'erase') {
          person.name = 'Người dùng đã xoá';
          result = { erased: true };
        } else {
          restrictedPersons.add(person.id);
          result = { restricted: true };
        }
        const list = dataRequests.get(person.id) ?? [];
        list.unshift({ id, kind, status: 'completed', requested_at: new Date().toISOString(), completed_at: new Date().toISOString() });
        dataRequests.set(person.id, list);
        return reply(201, { id, kind, status: 'completed', result });
      }
    }

    return false;
  }

  // ── Bước 10–11 (gọi thẳng từ `mock-api.ts`, không qua `handle`) ──
  function step10(body: Record<string, unknown>, existingEmails: Set<string>): StepResult<{ invited: Step10Invited[] }> {
    const invitesIn = Array.isArray(body.invites) ? (body.invites as Array<Record<string, unknown>>) : [];
    const errors: Record<string, string> = {};
    const seen = new Set<string>();
    const invited: Step10Invited[] = [];
    invitesIn.forEach((inv, idx) => {
      const email = String(inv.email ?? '').trim().toLowerCase();
      const name = String(inv.display_name ?? '').trim();
      const role = String(inv.role ?? '');
      if (!EMAIL_RE.test(email)) errors[`invites.${idx}.email`] = 'Email chưa đúng định dạng';
      else if (seen.has(email)) errors[`invites.${idx}.email`] = 'Email bị lặp trong danh sách';
      else if (existingEmails.has(email)) errors[`invites.${idx}.email`] = 'Email đã có tài khoản';
      if (!name) errors[`invites.${idx}.display_name`] = 'Nhập tên hiển thị';
      if (!INVITE_ROLES.has(role)) errors[`invites.${idx}.role`] = 'Chọn vai trò';
      if (errors[`invites.${idx}.email`] || errors[`invites.${idx}.display_name`] || errors[`invites.${idx}.role`]) return;
      seen.add(email);
      invited.push({ id: randomUUID(), display_name: name, email, role, temp_password: randomUUID().replace(/-/g, '').slice(0, 10) });
    });
    if (Object.keys(errors).length) return { ok: false, status: 422, code: 'VALIDATION_ERROR', title: 'Dữ liệu chưa hợp lệ', extra: { errors } };
    return { ok: true, value: { invited } };
  }

  function step11(body: Record<string, unknown>): StepResult<{ backup: BackupConfig }> {
    const time_of_day = String(body.time_of_day ?? '02:00');
    if (!TIME_RE.test(time_of_day)) {
      return { ok: false, status: 422, code: 'VALIDATION_ERROR', title: 'Dữ liệu chưa hợp lệ', extra: { errors: { time_of_day: 'Giờ chạy sao lưu dạng HH:MM (00:00–23:59)' } } };
    }
    const frequency = ['daily', 'weekly', 'monthly'].includes(String(body.frequency)) ? (body.frequency as BackupConfig['frequency']) : 'daily';
    const destination = ['local', 's3', 'minio'].includes(String(body.destination)) ? (body.destination as BackupConfig['destination']) : 'local';
    const retention_count = Math.min(365, Math.max(1, Math.round(Number(body.retention_count ?? 7)) || 7));
    Object.assign(backup, { frequency, time_of_day, retention_count, destination });
    return { ok: true, value: { backup: { ...backup } } };
  }

  return {
    handle,
    step10,
    step11,
    hooks: {} as Record<string, (...args: never[]) => unknown>,
    dispose: () => {},
  };
}
