import { useMemo, useState } from 'react';
import { EmptyState, Icon } from '@gen-harness/ui';
import { downloadText } from '../../lib/download';
import { fmtDMClock } from '../../lib/format';
import { useCan, useOrgTimezone } from '../../lib/permissions';
import { errorText } from '../../lib/errorText';
import { toast } from '../../lib/toast';
import { CardError, SkeletonLines } from '../common';
import { N4 } from '../data/dataModel';
import { auditActorTone, auditResultView } from './systemModel';
import { useExportAuditLog, useSystemAuditLog } from './queries';

const ACTOR_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Mọi tác nhân' },
  { value: 'user', label: 'Người' },
  { value: 'agent', label: 'Agent' },
  { value: 'system', label: 'Hệ thống' },
  { value: 'plugin', label: 'Plugin' },
];

/** Nhật ký hệ thống — tìm, xuất CSV (PLAN 4.5, spec `auditLog`). */
export function LogTab() {
  const canRead = useCan('audit.read');
  const canExport = useCan('data.manage');
  const tz = useOrgTimezone();
  const [actorType, setActorType] = useState('');
  const [search, setSearch] = useState('');
  const q = useSystemAuditLog({ actor_type: actorType || undefined, limit: 100 });
  const exportCsv = useExportAuditLog();

  const rows = useMemo(() => {
    const items = q.data?.items ?? [];
    const s = search.trim().toLowerCase();
    if (!s) return items;
    return items.filter((a) => (a.actor_label ?? '').toLowerCase().includes(s) || a.action.toLowerCase().includes(s) || (a.target_label ?? '').toLowerCase().includes(s));
  }, [q.data, search]);

  const onExport = () => {
    exportCsv.mutate(
      { actor_type: actorType || undefined },
      {
        onSuccess: (csv) => {
          const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          downloadText(csv, `nhat-ky-${d}.csv`);
          toast('Đã xuất nhật ký hành động');
        },
        onError: (e) => toast(errorText(e), 'bad'),
      },
    );
  };

  if (!canRead) {
    return (
      <div className="gh-card">
        <EmptyState icon="ph ph-lock-simple" title="Vai trò của bạn không xem được Nhật ký" description="Nhật ký hành động chỉ hiện với vai trò có quyền xem — Manager thấy nhật ký team mình." />
      </div>
    );
  }

  return (
    <div className="gh-card sys-log">
      <div className="sys-log__head">
        <div>
          <div className="gh-card__title">Nhật ký hành động</div>
          <div className="gh-card__kicker">Action log · Auditor xem được, không hành động</div>
        </div>
        <div className="sys-log__tools">
          <div className="sys-log__search">
            <Icon name="ph ph-magnifying-glass" size={14} color="var(--color-neutral-700)" />
            <input
              className="sys-log__search-input"
              placeholder="Tìm người, hành động…"
              aria-label="Tìm trong nhật ký"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select className="sys-log__actor" aria-label="Lọc theo loại tác nhân" value={actorType} onChange={(e) => setActorType(e.target.value)}>
            {ACTOR_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {canExport ? (
            <button type="button" className="gh-btn gh-btn--secondary btn-30" onClick={onExport} disabled={exportCsv.isPending}>
              <Icon name="ph ph-download-simple" size={14} />
              {exportCsv.isPending ? 'Đang xuất…' : 'Xuất CSV'}
            </button>
          ) : null}
        </div>
      </div>

      {q.isPending ? (
        <SkeletonLines rows={6} padding="10px 16px" />
      ) : q.isError ? (
        <CardError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : rows.length === 0 ? (
        <EmptyState icon="ph ph-list-checks" title="Chưa có hành động nào khớp" />
      ) : (
        <div className="gh-table-scroll">
          <table className="sys-log__table">
            <thead>
              <tr>
                <th>Thời điểm</th>
                <th>Ai / agent nào</th>
                <th>Hành động</th>
                <th>Đối tượng</th>
                <th>Tự trị</th>
                <th>Kết quả</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const r = auditResultView(a.result);
                return (
                  <tr key={a.id}>
                    <td className="mono sys-log__time">{fmtDMClock(a.at, tz)}</td>
                    <td style={{ color: auditActorTone(a.actor_type) }}>{a.actor_label ?? '—'}</td>
                    <td className="mono sys-log__action">{a.action}</td>
                    <td className="sys-log__target">{a.target_label ?? '—'}</td>
                    <td className="mono" style={{ color: N4 }}>
                      {a.autonomy_level != null ? `mức ${a.autonomy_level}` : '—'}
                    </td>
                    <td>
                      <span className="sys-log__result" style={{ color: r.tone, borderColor: r.tone }}>
                        {r.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
