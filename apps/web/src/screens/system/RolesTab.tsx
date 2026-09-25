import { useState } from 'react';
import type { PermScope } from '@gen-harness/contracts';
import { STATIC_HARD_BOUNDARIES } from '@gen-harness/contracts';
import { EmptyState, Icon, Switch, TextField } from '@gen-harness/ui';
import { fmtInt } from '../../lib/format';
import { useCan } from '../../lib/permissions';
import { errorText } from '../../lib/errorText';
import { CardError, InlineError, Panel, SkeletonLines } from '../common';
import { BAD, N5, OK, WARN } from '../data/dataModel';
import { BOUNDARY_ICON, GROUP_KIND_LABEL, LISTEN_MODES, SCOPE_CELL, SCOPE_OPTIONS, VIEW_SCOPES, boundaryTone, cellLocked, listenTone } from './systemModel';
import { useBoundaries, useListeningGroups, usePatchBoundary, usePatchPermission, usePermissions } from './queries';

/** Quyền hạn — ma trận vai trò, nhóm đang lắng nghe, ranh giới có trách nhiệm (PLAN 4.5). */
export function RolesTab() {
  const canRead = useCan('system.read');
  if (!canRead) {
    return (
      <div className="gh-card">
        <EmptyState
          icon="ph ph-lock-simple"
          title="Vai trò của bạn không xem được Quyền hạn"
          description="Ma trận quyền, nhóm lắng nghe và ranh giới chỉ hiện với vai trò có quyền xem hệ thống."
        />
      </div>
    );
  }
  return (
    <div className="sys-tabs-col">
      <PermissionMatrix />
      <div className="sys-grid2">
        <ListeningGroupsPanel />
        <BoundariesPanel />
      </div>
    </div>
  );
}

function PermissionMatrix() {
  const canManage = useCan('roles.manage');
  const q = usePermissions();
  const patch = usePatchPermission();
  const [busyCell, setBusyCell] = useState<string | null>(null);

  const onChange = (role: string, permission: string, scope: PermScope) => {
    const key = `${role}:${permission}`;
    setBusyCell(key);
    patch.mutate(
      { role: role as 'owner' | 'manager' | 'operator' | 'agent_staff' | 'auditor', permission, scope },
      { onSettled: () => setBusyCell((k) => (k === key ? null : k)) },
    );
  };

  return (
    <Panel
      title="Ma trận quyền theo vai trò"
      kicker="Dữ liệu đánh giá nhân sự khoá chặt hơn dữ liệu cơ hội · đổi quyền cần mã PIN"
      label="Ma trận quyền theo vai trò"
      bodyClass="roles-matrix-wrap"
    >
      {q.isPending ? (
        <SkeletonLines rows={5} padding="10px 16px" />
      ) : q.isError ? (
        <CardError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <>
          <div className="roles-legend">
            {(['all', 'team', 'none'] as PermScope[]).map((s) => (
              <span className="roles-legend__item" key={s}>
                <Icon name={SCOPE_CELL[s].icon} size={13} color={SCOPE_CELL[s].tone} />
                {s === 'all' ? 'toàn quyền' : s === 'team' ? 'có giới hạn' : 'không'}
              </span>
            ))}
          </div>
          <table className="roles-matrix">
            <thead>
              <tr>
                <th>Vai trò</th>
                {q.data.columns.map((c) => (
                  <th key={c.key} className="roles-matrix__col">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data.roles.map((role) => (
                <tr key={role.code}>
                  <td>
                    <div className="roles-matrix__role">{role.name}</div>
                    <div className="roles-matrix__meta">{role.meta}</div>
                  </td>
                  {q.data.columns.map((c) => {
                    // Mỗi cột có thể gồm nhiều quyền (vd Đánh giá nhân sự = 3 quyền) — ô hiện/sửa quyền ĐỌC
                    // của cột (phần tử đầu `c.permissions`), quyền ghi cùng cột đổi kèm khi cần ở backend.
                    const primary = c.permissions[0];
                    const scope = role.permissions[primary] ?? 'none';
                    const locked = cellLocked(role.code, primary);
                    const cell = SCOPE_CELL[scope];
                    const key = `${role.code}:${primary}`;
                    if (!canManage || locked) {
                      return (
                        <td key={c.key} className="roles-matrix__cell" data-locked={locked || undefined}>
                          <span title={locked ? 'Khoá cứng — không sửa được (ARCHITECTURE §7.4/§8.3)' : cell.title}>
                            <Icon name={cell.icon} size={15} color={cell.tone} />
                          </span>
                        </td>
                      );
                    }
                    return (
                      <td key={c.key} className="roles-matrix__cell">
                        <select
                          className="roles-matrix__select"
                          aria-label={`${role.name} · ${c.label}`}
                          value={scope}
                          disabled={busyCell === key}
                          onChange={(e) => onChange(role.code, primary, e.target.value as PermScope)}
                        >
                          {SCOPE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {patch.isError ? <InlineError>{errorText(patch.error)}</InlineError> : null}
    </Panel>
  );
}

function ListeningGroupsPanel() {
  const groups = useListeningGroups();
  return (
    <Panel title="Nhóm đang lắng nghe" kicker="Chỉ nhóm tổ chức có quyền hợp lệ — khoá cứng #1" label="Nhóm đang lắng nghe" bodyClass="roles-groups-wrap">
      {groups.isPending ? (
        <SkeletonLines rows={4} padding="10px 16px" />
      ) : groups.isError ? (
        <CardError error={groups.error} onRetry={() => void groups.refetch()} retrying={groups.isFetching} />
      ) : groups.data.length === 0 ? (
        <EmptyState icon="ph ph-users-three" title="Chưa có nhóm nào đang lắng nghe" />
      ) : (
        <table className="roles-groups">
          <thead>
            <tr>
              <th>Nhóm</th>
              <th>Chế độ nghe</th>
              <th>Quyền xem</th>
            </tr>
          </thead>
          <tbody>
            {groups.data.map((g) => (
              <tr key={g.id}>
                <td>
                  <div className="roles-groups__name">{g.name}</div>
                  <div className="roles-groups__meta">
                    {fmtInt(g.members)} thành viên · {GROUP_KIND_LABEL[g.kind as keyof typeof GROUP_KIND_LABEL] ?? g.kind}
                  </div>
                </td>
                <td>
                  <span className="roles-groups__mode" style={{ color: listenTone(g.listen_mode) }}>
                    {LISTEN_MODES.find((m) => m.value === g.listen_mode)?.label ?? g.listen_mode}
                  </span>
                </td>
                <td>
                  <span className="roles-groups__scope">{VIEW_SCOPES.find((v) => v.value === g.view_scope)?.label ?? g.view_scope}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function BoundariesPanel() {
  const canManage = useCan('system.manage');
  const q = useBoundaries();
  const patch = usePatchBoundary();
  const [threshold, setThreshold] = useState<string | null>(null);

  const gate = q.data?.find((b) => b.code === 'approval_gate');
  const thresholdValue = threshold ?? (gate?.params.approval_threshold_vnd != null ? String(gate.params.approval_threshold_vnd) : '');

  const saveThreshold = () => {
    const n = Number(threshold);
    if (threshold === null || !Number.isInteger(n) || n < 0) return;
    patch.mutate({ code: 'approval_gate', body: { params: { approval_threshold_vnd: n } } }, { onSuccess: () => setThreshold(null) });
  };

  return (
    <Panel
      title="Ranh giới có trách nhiệm"
      kicker="Hệ thống quan sát, không phải máy kết án — 8 khoá cứng ARCHITECTURE §7.4"
      label="Ranh giới có trách nhiệm"
      bodyClass="roles-boundaries"
    >
      {q.isPending ? (
        <SkeletonLines rows={6} padding="10px 16px" />
      ) : q.isError ? (
        <CardError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <>
          {q.data.map((b) => (
            <div className="boundary-row" key={b.code}>
              <Icon name={BOUNDARY_ICON[b.code] ?? 'ph ph-shield'} size={15} color={boundaryTone(b)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="boundary-row__label">{b.label}</div>
                {b.locked ? <div className="boundary-row__hint">Khoá cứng — không tắt/bật được, kể cả Owner.</div> : null}
                {b.code === 'approval_gate' ? (
                  <div className="boundary-row__threshold">
                    <TextField
                      label="Ngưỡng chờ duyệt (₫)"
                      type="number"
                      min={0}
                      step={1000000}
                      value={thresholdValue}
                      disabled={!canManage}
                      onChange={(e) => setThreshold(e.target.value)}
                      onBlur={saveThreshold}
                    />
                  </div>
                ) : null}
              </div>
              {canManage ? (
                <Switch
                  checked={b.enabled}
                  label={`${b.enabled ? 'Tắt' : 'Bật'} ${b.label}`}
                  disabled={b.locked || patch.isPending}
                  onChange={(v) => patch.mutate({ code: b.code, body: { enabled: v } })}
                />
              ) : (
                <span className="boundary-row__state" style={{ color: b.enabled ? OK : N5 }}>
                  {b.enabled ? 'Đang bật' : 'Đang tắt'}
                </span>
              )}
            </div>
          ))}
          {STATIC_HARD_BOUNDARIES.map((b) => (
            <div className="boundary-row" key={b.label} data-static="">
              <Icon name="ph ph-lock-simple" size={15} color={BAD} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="boundary-row__label">{b.label}</div>
                <div className="boundary-row__hint">{b.hint}</div>
              </div>
              <span className="boundary-row__state" style={{ color: WARN }}>
                Không có công tắc
              </span>
            </div>
          ))}
        </>
      )}
      {patch.isError ? <InlineError>{errorText(patch.error)}</InlineError> : null}
    </Panel>
  );
}
