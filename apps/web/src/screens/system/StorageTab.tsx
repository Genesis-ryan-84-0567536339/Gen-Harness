import { useMemo, useState } from 'react';
import { ApiError, type RetentionEditableDataset, type RetentionPolicy } from '@gen-harness/contracts';
import { Button, EmptyState, Icon, SelectField, TextField } from '@gen-harness/ui';
import { useDirPeople } from '../relations/queries';
import { fmtDMClock } from '../../lib/format';
import { useCan, useOrgTimezone } from '../../lib/permissions';
import { errorText } from '../../lib/errorText';
import { toast } from '../../lib/toast';
import { CardError, InlineError, Panel, SkeletonLines } from '../common';
import { UpdateCard } from '../../update/UpdateCard';
import { BackupPanel } from './BackupPanel';
import { OffsitePanel } from './OffsitePanel';
import { HealthCard } from './HealthCard';
import { DATA_REQUEST_KIND, RETENTION_LABEL, retentionRowView } from './systemModel';
import { useCreateDataRequest, usePatchRetention, usePersonDataRequests, useRetentionPolicies } from './queries';

/** Dữ liệu & lưu trữ — sao lưu & khôi phục (v0.1.20), bản sao ngoài máy (v0.1.40); spec I: hạn lưu theo tập dữ liệu, yêu cầu xuất/xoá/giới hạn
 * dữ liệu một người (PLAN 4.5). */
export function StorageTab() {
  const canRead = useCan('system.read');
  const canManage = useCan('system.manage');
  if (!canRead) {
    return (
      <div className="gh-card">
        <EmptyState icon="ph ph-lock-simple" title="Vai trò của bạn không xem được Dữ liệu & lưu trữ" />
      </div>
    );
  }
  return (
    <div className="sys-tabs-col">
      {/* v0.1.36 (F-6): sức khoẻ hệ thống đứng đầu — Bộ xử lý nền, sao lưu, cập nhật, ổ đĩa. */}
      <HealthCard />
      {/* v0.1.30: mục cập nhật cố định — thẻ Tổng quan chỉ hiện khi đã biết có bản mới. */}
      {canManage ? <UpdateCard always /> : null}
      <BackupPanel />
      {/* v0.1.40 (F-12): bản sao ra ổ USB/NAS — ngay sau Sao lưu & khôi phục. */}
      <OffsitePanel />
      <RetentionPanel />
      <PersonDataRequestPanel />
    </div>
  );
}

/**
 * v0.1.40 (F-2): việc nền dọn dữ liệu theo hạn lưu đã chạy thật — nút "Sửa" mở lại cho dòng `editable`. Dòng
 * `not_applicable` (Nhật ký hành động — chỉ ghi thêm) hiện "Không áp dụng"; `agent.browser_jobs.result` cố định
 * 14 ngày. "Ẩn danh sau" không hiện (hệ thống chưa thi hành ẩn danh — không hứa điều chưa làm); PATCH gửi lại nguyên
 * `anonymize_after_days` đang có để không xoá cấu hình cũ.
 */
function RetentionPanel() {
  const canManage = useCan('system.manage');
  const tz = useOrgTimezone();
  const q = useRetentionPolicies();
  const patch = usePatchRetention();
  const [editing, setEditing] = useState<RetentionEditableDataset | null>(null);
  const [keepDays, setKeepDays] = useState('');

  const startEdit = (r: RetentionPolicy) => {
    patch.reset();
    setEditing(r.dataset as RetentionEditableDataset);
    setKeepDays(r.keep_days != null ? String(r.keep_days) : '');
  };
  const save = (r: RetentionPolicy) => {
    patch.mutate(
      { dataset: r.dataset as RetentionEditableDataset, keep_days: keepDays.trim() ? Number(keepDays) : null, anonymize_after_days: r.anonymize_after_days },
      { onSuccess: () => setEditing(null) },
    );
  };
  const fieldErrors = patch.error instanceof ApiError && patch.error.status === 422 ? patch.error.fieldErrors : {};
  const keepError = typeof fieldErrors.keep_days === 'string' ? fieldErrors.keep_days : null;
  const otherFieldErrors = Object.entries(fieldErrors).filter(([k, m]) => k !== 'keep_days' && typeof m === 'string');

  return (
    <Panel
      genTarget="system.storage.retention"
      title="Hạn lưu dữ liệu"
      kicker="Mỗi tập dữ liệu một hạn — đổi cần mã PIN"
      label="Hạn lưu dữ liệu"
      bodyClass="retention-wrap"
    >
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
              {canManage ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {q.data.map((r) => {
              const view = retentionRowView(r, tz);
              return (
                <tr key={r.dataset} data-testid={`retention-${r.dataset}`}>
                  <td>
                    <div className="retention-table__name">{RETENTION_LABEL[r.dataset] ?? r.dataset}</div>
                    <div className="mono retention-table__code">{r.dataset}</div>
                    {view.note ? <div className="retention-table__note">{view.note}</div> : null}
                    {view.lastRun ? <div className="retention-table__last">{view.lastRun}</div> : null}
                  </td>
                  {editing === r.dataset ? (
                    <>
                      <td>
                        <TextField
                          label={`Giữ trong (ngày) — ${r.dataset}`}
                          type="number"
                          min={1}
                          max={3650}
                          value={keepDays}
                          onChange={(e) => setKeepDays(e.target.value)}
                          placeholder="mãi mãi"
                          error={keepError}
                        />
                      </td>
                      <td className="retention-table__actions">
                        <Button variant="ghost" className="btn-27" onClick={() => setEditing(null)}>
                          Huỷ
                        </Button>
                        <Button variant="primary" className="btn-27" loading={patch.isPending} onClick={() => save(r)}>
                          Lưu
                        </Button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className={view.applicable ? 'mono' : undefined}>{view.keep}</td>
                      {canManage ? (
                        <td className="retention-table__actions">
                          {view.editable ? (
                            <Button variant="ghost" className="btn-27" icon="ph ph-pencil-simple" onClick={() => startEdit(r)} aria-label={`Sửa hạn lưu ${RETENTION_LABEL[r.dataset] ?? r.dataset}`}>
                              Sửa
                            </Button>
                          ) : null}
                        </td>
                      ) : null}
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {patch.isError && !keepError ? (
        <InlineError>
          {otherFieldErrors.length ? otherFieldErrors.map(([, m]) => m).join(' · ') : errorText(patch.error)}
        </InlineError>
      ) : null}
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
      kicker="Có ghi vào Nhật ký — dữ liệu gốc không bị sửa"
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
