import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { EmptyState, Icon } from '@gen-harness/ui';
import { qk2, useProviders } from '../../lib/dataQueries';
import { useFailoverRules, useTestProvider } from '../api/queries';
import { fmtQuota, providerStatus } from '../api/apiModel';
import { CardError, Panel, SkeletonLines } from '../common';
import { N4, OK, WARN } from '../data/dataModel';
import { CliCard } from './CliCard';
import { JevCard } from './JevCard';
import { TriageCard } from './TriageCard';
import { BackgroundSourcesCard } from './BackgroundSourcesCard';
import { AiBudgetCard } from './AiBudgetCard';
import { useCan } from '../../lib/permissions';

/**
 * Bộ não AI — góc nhìn vận hành hệ thống (PLAN 4.5): hạn mức theo model, chuỗi chuyển hướng, quy tắc chuyển
 * hướng, tài khoản CLI. Cấu hình chi tiết provider/khoá/gán model theo agent đã có màn riêng `api`
 * (`screens/api/ApiScreen.tsx`, PLAN 4.2) — tab này CHỈ ĐỌC LẠI cùng dữ liệu (`useProviders`,
 * `useFailoverRules`), không lặp lại logic sửa/thêm/kéo-thả, và dẫn sang màn đó cho việc cấu hình đầy đủ.
 */
export function BrainTab() {
  const canManage = useCan('system.manage');
  const providers = useProviders();
  const rules = useFailoverRules();
  const qc = useQueryClient();
  // v0.1.39 (F-78): Jev không bắt buộc — kiểm tra lỗi thì thu thẻ vào "Nâng cao" thay vì để lỗi đỏ giữa tab.
  // Mutation giữ ở đây để kết quả "Kiểm tra 1 lần" còn nguyên khi thẻ chuyển chỗ.
  const jevTest = useTestProvider();
  const [jevFailedNow, setJevFailedNow] = useState(false);
  const jev = (providers.data ?? []).find((p) => p.kind === 'system_one');
  const jevFailed =
    !!jev && (jevFailedNow || jev.last_test?.ok === false || jev.auth_state === 'error' || jev.auth_state === 'expired');
  const onJevFailed = () => {
    setJevFailedNow(true);
    void qc.invalidateQueries({ queryKey: qk2.providers });
  };
  const jevCard = <JevCard test={jevTest} onFailed={onJevFailed} />;
  // Jev (system_one) không nằm trong chuỗi sinh chữ — hiện riêng ở thẻ Jev.
  const sorted = [...(providers.data ?? [])].filter((p) => p.kind !== 'system_one').sort((a, b) => a.failover_rank - b.failover_rank);
  const models = sorted.flatMap((p) => p.models.map((m) => ({ ...m, providerName: p.name, providerId: p.id, enabled: p.enabled })));

  return (
    <div className="sys-tabs-col">
      <Panel
        title="Hạn mức theo model"
        genTarget="system.brain.quota"
        kicker="Mức dùng trong ngày của từng model"
        label="Hạn mức theo model"
        bodyClass="brain-quota-wrap"
        aside={
          <Link to="/api" className="gh-btn gh-btn--secondary btn-27" data-gen-target="system.brain.open_api">
            <Icon name="ph ph-arrow-square-out" size={13} />
            Mở API &amp; Model
          </Link>
        }
      >
        {providers.isPending ? (
          <SkeletonLines rows={4} padding="10px 16px" />
        ) : providers.isError ? (
          <CardError error={providers.error} onRetry={() => void providers.refetch()} retrying={providers.isFetching} />
        ) : models.length === 0 ? (
          <EmptyState icon="ph ph-brain" title="Chưa có model nào" description="Thêm nhà cung cấp và model ở màn API & Model." />
        ) : (
          <table className="brain-quota">
            <thead>
              <tr>
                <th>Model</th>
                <th>Nhà cung cấp</th>
                <th>Dùng trong ngày</th>
                <th>Còn lại</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const pct = m.daily_quota ? Math.min(100, (m.used_today * 100) / m.daily_quota) : 0;
                const leftPct = m.daily_quota ? Math.max(0, 100 - pct) : null;
                const tone = !m.enabled ? N4 : leftPct == null ? OK : leftPct < 20 ? WARN : OK;
                return (
                  <tr key={m.id}>
                    <td className="mono">{m.model_name}</td>
                    <td>{m.providerName}</td>
                    <td>
                      <div className="brain-quota__bar">
                        <span className="brain-quota__track">
                          <span className="brain-quota__fill" style={{ width: `${pct}%`, background: tone }} />
                        </span>
                        <span className="mono brain-quota__used">{fmtQuota(m.used_today, m.daily_quota)}</span>
                      </div>
                    </td>
                    <td className="mono" style={{ color: tone }}>
                      {leftPct == null ? '—' : `${leftPct.toFixed(0)}%`}
                    </td>
                    <td>
                      <span className="brain-quota__state" style={{ color: tone }}>
                        {!m.enabled ? 'Đã tắt' : leftPct != null && leftPct < 20 ? 'Sắp cạn hạn mức' : 'Khoẻ mạnh'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="sys-grid2">
        <Panel genTarget="system.brain.chain" title="Chuỗi chuyển hướng" kicker="Thứ tự dùng nguồn — sửa ở màn API & Model" label="Chuỗi chuyển hướng" bodyClass="brain-chain">
          {providers.isPending ? (
            <SkeletonLines rows={3} padding="10px 16px" />
          ) : providers.isError ? (
            <CardError error={providers.error} onRetry={() => void providers.refetch()} retrying={providers.isFetching} />
          ) : sorted.length === 0 ? (
            <EmptyState icon="ph ph-arrows-down-up" title="Chưa có nhà cung cấp nào" />
          ) : (
            <ol className="brain-chain-list">
              {sorted.map((p, i) => (
                <li className="brain-chain-row" key={p.id}>
                  <span className="mono brain-chain-row__rank">{String(i + 1).padStart(2, '0')}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="brain-chain-row__name">{p.name}</div>
                    <div className="mono brain-chain-row__model">{p.models[0]?.model_name ?? '—'}</div>
                  </div>
                  <span className="brain-chain-row__state" style={{ color: providerStatus(p).tone }}>
                    {providerStatus(p).label}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
        <Panel title="Quy tắc chuyển hướng" kicker="Cố định, không cần chỉnh" label="Quy tắc chuyển hướng" bodyClass="brain-rules">
          {rules.isPending ? (
            <SkeletonLines rows={4} padding="8px 16px" />
          ) : rules.isError ? (
            <CardError error={rules.error} onRetry={() => void rules.refetch()} retrying={rules.isFetching} />
          ) : (
            rules.data.map((r) => (
              <div className="brain-rule-row" key={r.key}>
                <span className="mono brain-rule-row__key">{r.key}</span>
                <span className="brain-rule-row__val">{r.value}</span>
              </div>
            ))
          )}
        </Panel>
      </div>

      <div className="sys-grid2">
        {jevFailed ? (
          <details className="brain-advanced">
            <summary>Nâng cao — Jev (đã ẩn vì kiểm tra lỗi, không bắt buộc)</summary>
            {jevCard}
          </details>
        ) : (
          jevCard
        )}
        <CliCard canManage={canManage} showCredentials={false} />
      </div>

      {/* v0.1.41 (F-86, F-84): nguồn AI cho việc nền (khoá API mặc định; Claude Code CLI cần cảnh báo + PIN) và chi phí. */}
      <div className="sys-grid2">
        <BackgroundSourcesCard />
        <AiBudgetCard />
      </div>

      <div className="sys-grid2">
        <TriageCard />
      </div>
    </div>
  );
}
