import { useMemo, useState } from 'react';
import type { RetentionDataset } from '@gen-harness/contracts';
import { Button, EmptyState, Icon, SelectField, TextField } from '@gen-harness/ui';
import { useDirPeople } from '../relations/queries';
import { fmtDMClock } from '../../lib/format';
import { useCan, useOrgTimezone } from '../../lib/permissions';
import { errorText } from '../../lib/errorText';
import { toast } from '../../lib/toast';
import { CardError, InlineError, Panel, SkeletonLines } from '../common';
import { DATA_REQUEST_KIND, RETENTION_LABEL } from './systemModel';
import { useCreateDataRequest, usePatchRetention, usePersonDataRequests, useRetentionPolicies } from './queries';

/** Dữ liệu & lưu trữ — spec I: hạn lưu theo tập dữ liệu, yêu cầu xuất/xoá/giới hạn dữ liệu một người (PLAN 4.5). */
export function StorageTab() {
  const canRead = useCan('system.read');
  if (!canRead) {
    return (
      <div className="gh-card">
        <EmptyState icon="ph ph-lock-simple" title="Vai trò của bạn không xem được Dữ liệu & lưu trữ" />
      </div>
    );
  }
  return (
    <div className="sys-tabs-col">
      <RetentionPanel />
      <PersonDataRequestPanel />
    </div>
  );
}

function RetentionPanel() {
  const canManage = useCan('system.manage');
  const q = useRetentionPolicies();
  const patch = usePatchRetention();
  const [editing, setEditing] = useState<RetentionDataset | null>(null);
  const [keepDays, setKeepDays] = useState('');
  const [anonDays, setAnonDays] = useState('');

  const startEdit = (dataset: RetentionDataset, keep: number | null, anon: number | null) => {
    setEditing(dataset);
    setKeepDays(keep != null ? String(keep) : '');
    setAnonDays(anon != null ? String(anon) : '');
  };
  const save = () => {
    if (!editing) return;
    patch.mutate(
      { dataset: editing, keep_days: keepDays.trim() ? Number(keepDays) : null, anonymize_after_days: anonDays.trim() ? Number(anonDays) : null },
      { onSuccess: () => setEditing(null) },
    );
  };

  return (
    <Panel title="Hạn lưu dữ liệu" kicker="Mỗi tập dữ liệu một hạn — đổi cần mã PIN" label="Hạn lưu dữ liệu" bodyClass="retention-wrap">
      {q.isPending ? (
        <SkeletonLines rows={5} padding="10px 16px" />
      ) : q.isError ? (
        <CardError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <table className="retention-table">
          <thead>
            <tr>
              <th>Tập dữ liệu</th>
              <th>Giữ trong</th>
              <th>Ẩn danh sau</th>
              {canManage ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {q.data.map((r) => (
              <tr key={r.dataset}>
                <td>
                  <div className="retention-table__name">{RETENTION_LABEL[r.dataset] ?? r.dataset}</div>
                  <div className="mono retention-table__code">{r.dataset}</div>
                </td>
                {editing === r.dataset ? (
                  <>
                    <td>
                      <TextField label={`Giữ trong (ngày) — ${r.dataset}`} type="number" min={1} max={3650} value={keepDays} onChange={(e) => setKeepDays(e.target.value)} placeholder="mãi mãi" />
                    </td>
                    <td>
                      <TextField label={`Ẩn danh sau (ngày) — ${r.dataset}`} type="number" min={1} max={3650} value={anonDays} onChange={(e) => setAnonDays(e.target.value)} placeholder="không" />
                    </td>
                    <td className="retention-table__actions">
                      <Button variant="ghost" className="btn-27" onClick={() => setEditing(null)}>
                        Huỷ
                      </Button>
                      <Button variant="primary" className="btn-27" loading={patch.isPending} onClick={save}>
                        Lưu
                      </Button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="mono">{r.keep_days != null ? `${r.keep_days} ngày` : 'mãi mãi'}</td>
                    <td className="mono">{r.anonymize_after_days != null ? `${r.anonymize_after_days} ngày` : '—'}</td>
                    {canManage ? (
                      <td className="retention-table__actions">
                        <Button variant="ghost" className="btn-27" icon="ph ph-pencil-simple" onClick={() => startEdit(r.dataset, r.keep_days, r.anonymize_after_days)}>
                          Sửa
                        </Button>
                      </td>
                    ) : null}
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {patch.isError ? <InlineError>{errorText(patch.error)}</InlineError> : null}
    </Panel>
  );
}

function PersonDataRequestPanel() {
  const canManage = useCan('system.manage');
  const tz = useOrgTimezone();
  const people = useDirPeople({ limit: 50 });
  const [search, setSearch] = useState('');
  const [personId, setPersonId] = useState('');
  const create = useCreateDataRequest();
  const history = usePersonDataRequests(personId, !!personId);

  const options = useMemo(() => {
    const s = search.trim().toLowerCase();
    const items = people.data?.items ?? [];
    return (s ? items.filter((p) => p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s)) : items).slice(0, 30);
  }, [people.data, search]);
  const person = options.find((p) => p.id === personId) ?? (people.data?.items ?? []).find((p) => p.id === personId);

  const request = (kind: 'export' | 'erase' | 'restrict') => {
    if (!personId) return;
    create.mutate(
      { personId, kind },
      {
        onSuccess: () => toast(kind === 'export' ? 'Đã tạo gói xuất dữ liệu' : kind === 'erase' ? 'Đã xoá dữ liệu suy ra của người này' : 'Đã giới hạn dùng dữ liệu người này', 'ok'),
        onError: (e) => toast(errorText(e), 'bad'),
      },
    );
  };

  return (
    <Panel
      title="Yêu cầu xuất / xoá dữ liệu một người"
      kicker="Spec I · ghi vào nhật ký — không đụng kho thô (khoá cứng #5)"
      label="Yêu cầu xuất / xoá dữ liệu một người"
      bodyClass="data-request"
    >
      <div className="data-request__picker">
        <TextField label="Tìm người (tên hoặc mã)" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nguyễn Văn Bảo, PER-0042…" />
        <SelectField
          label="Người"
          value={personId}
          onChange={(e) => setPersonId(e.target.value)}
          options={[{ value: '', label: people.isPending ? 'Đang tải…' : 'Chọn người' }, ...options.map((p) => ({ value: p.id, label: `${p.name} · ${p.code}` }))]}
        />
      </div>
      {people.isError ? <CardError error={people.error} onRetry={() => void people.refetch()} retrying={people.isFetching} /> : null}

      <div className="data-request__actions">
        {(['export', 'erase', 'restrict'] as const).map((kind) => {
          const info = DATA_REQUEST_KIND[kind];
          return (
            <Button
              key={kind}
              variant={kind === 'erase' ? 'primary' : 'secondary'}
              icon={info.icon}
              disabled={!personId || create.isPending || !canManage}
              loading={create.isPending && create.variables?.kind === kind}
              onClick={() => request(kind)}
            >
              {info.label}
            </Button>
          );
        })}
      </div>
      {!canManage ? <p className="muted-note">Cần quyền quản lý hệ thống để gửi yêu cầu.</p> : null}
      {create.isError ? <InlineError>{errorText(create.error)}</InlineError> : null}

      {personId ? (
        <div className="data-request__history">
          <div className="data-request__history-title">Lịch sử yêu cầu — {person?.name ?? '…'}</div>
          {history.isPending ? (
            <SkeletonLines rows={2} padding="0" />
          ) : history.isError ? (
            <CardError error={history.error} onRetry={() => void history.refetch()} retrying={history.isFetching} />
          ) : history.data.length === 0 ? (
            <p className="muted-note">Chưa có yêu cầu nào cho người này.</p>
          ) : (
            history.data.map((r) => (
              <div className="data-request__row" key={r.id}>
                <Icon name={DATA_REQUEST_KIND[r.kind]?.icon ?? 'ph ph-file'} size={14} color={DATA_REQUEST_KIND[r.kind]?.tone} />
                <span style={{ flex: 1, minWidth: 0 }}>{DATA_REQUEST_KIND[r.kind]?.label ?? r.kind}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--color-neutral-500)' }}>
                  {fmtDMClock(r.requested_at, tz)}
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </Panel>
  );
}
