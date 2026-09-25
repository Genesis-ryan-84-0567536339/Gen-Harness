import { useState, type DragEvent } from 'react';
import type { AgentBindingSlot, Provider, ProviderKind } from '@gen-harness/contracts';
import { SCREEN_BY_KEY } from '@gen-harness/contracts';
import { Button, Dialog, EmptyState, Icon, SelectField, Switch, TextField } from '@gen-harness/ui';
import { useProviders } from '../../lib/dataQueries';
import { errorText } from '../../lib/errorText';
import { useCan } from '../../lib/permissions';
import { toast } from '../../lib/toast';
import { CardError, InlineError, Panel, ScreenHead, SkeletonLines, StateChip } from '../common';
import { CliCard } from '../system/CliCard';
import { AUTH_STATE_LABEL, PROVIDER_ICON, PROVIDER_KIND_LABEL, fmtContextTokens, fmtQuota, fmtTemperature, providerTone } from './apiModel';
import {
  useAddModel,
  useAddProviderKey,
  useBindings,
  useCreateProvider,
  useFailoverRules,
  useRemoveBinding,
  useReorderChain,
  useSetBinding,
  useSetProviderEnabled,
  useTestProvider,
} from './queries';

export function ApiScreen() {
  const meta = SCREEN_BY_KEY.api;
  const canManage = useCan('system.manage');
  const providers = useProviders();
  const testAll = useTestProvider();
  const [addingProvider, setAddingProvider] = useState(false);
  const [addingKeyFor, setAddingKeyFor] = useState<Provider | null>(null);

  const testAllConnections = async () => {
    const list = (providers.data ?? []).filter((p) => p.kind !== 'antigravity_cli');
    let ok = 0;
    for (const p of list) {
      try {
        const r = await testAll.mutateAsync(p.id);
        if (r.ok) ok += 1;
      } catch {
        // đã báo lỗi qua từng nút "Kiểm tra" riêng của thẻ; ở đây chỉ đếm tổng
      }
    }
    toast(`Đã kiểm ${list.length} nhà cung cấp — ${ok} kết nối được`, ok === list.length ? 'ok' : 'warn');
  };

  const actions = (
    <>
      <Button variant="secondary" icon="ph ph-pulse" className="btn-30" loading={testAll.isPending} onClick={() => void testAllConnections()} disabled={!providers.data?.length}>
        Kiểm tra kết nối
      </Button>
      {canManage ? (
        <Button variant="primary" icon="ph ph-plus" className="btn-30" onClick={() => setAddingProvider(true)}>
          Thêm nhà cung cấp
        </Button>
      ) : null}
    </>
  );

  return (
    <div className="screen">
      <ScreenHead title={meta.title} description={meta.description} maxWidth={760} actions={actions} />

      <div className="apm-providers" aria-busy={providers.isFetching || undefined}>
        {providers.isPending ? (
          Array.from({ length: 2 }, (_, i) => <ProviderCardSkeleton key={i} />)
        ) : providers.isError ? (
          <div className="gh-card">
            <CardError error={providers.error} onRetry={() => void providers.refetch()} retrying={providers.isFetching} />
          </div>
        ) : providers.data.length === 0 ? (
          <div className="gh-card">
            <EmptyState icon="ph ph-plugs" title="Chưa có nhà cung cấp nào" description={canManage ? 'Thêm nhà cung cấp đầu tiên để agent có model để gọi.' : 'Owner chưa thêm nhà cung cấp nào.'} />
          </div>
        ) : (
          providers.data.map((p) => <ProviderCard key={p.id} provider={p} canManage={canManage} onAddKey={() => setAddingKeyFor(p)} />)
        )}
      </div>

      <div className="apm-mid">
        <BindingsPanel canManage={canManage} />
        <div className="apm-side">
          <CoreParamsPanel />
          <RateLimitsPanel />
        </div>
      </div>

      <div className="apm-panels">
        <PriorityChainPanel canManage={canManage} />
        <FailoverRulesPanel />
      </div>

      <CliCard canManage={canManage} />

      {addingProvider ? <AddProviderDialog onClose={() => setAddingProvider(false)} /> : null}
      {addingKeyFor ? <AddKeyDialog provider={addingKeyFor} onClose={() => setAddingKeyFor(null)} /> : null}
    </div>
  );
}

function ProviderCardSkeleton() {
  return (
    <div className="apm-provider" aria-hidden>
      <SkeletonLines rows={3} padding="0" />
    </div>
  );
}

function ProviderCard({ provider: p, canManage, onAddKey }: { provider: Provider; canManage: boolean; onAddKey: () => void }) {
  const test = useTestProvider();
  const setEnabled = useSetProviderEnabled();
  const tone = providerTone(p);
  const testErr = test.isError && test.variables === p.id ? test.error : null;
  const lastResult = test.data && test.variables === p.id ? test.data : null;
  return (
    <article className="apm-provider" aria-label={p.name}>
      <div className="apm-provider__head">
        <div className="apm-provider__icon" style={{ color: tone }}>
          <Icon name={PROVIDER_ICON[p.kind as ProviderKind]} size={15} />
        </div>
        <div className="apm-provider__title">
          <div className="apm-provider__name">{p.name}</div>
          <div className="apm-provider__kind">{PROVIDER_KIND_LABEL[p.kind as ProviderKind]}</div>
        </div>
        <StateChip color={tone} dot>
          {AUTH_STATE_LABEL[p.auth_state]}
        </StateChip>
      </div>
      <div className="apm-provider__body">
        {p.endpoint ? <ProviderField label="ENDPOINT" value={p.endpoint} tone="var(--color-neutral-300)" /> : null}
        <ProviderField
          label="KHOÁ"
          value={p.kind === 'antigravity_cli' ? 'dùng phiên đăng nhập CLI' : p.keys.length ? p.keys.map((k) => `${k.label} ····${k.last4}`).join(' · ') : 'chưa có khoá'}
          tone={p.keys.length || p.kind === 'antigravity_cli' ? 'var(--color-neutral-300)' : 'var(--color-warn)'}
          secret={p.kind !== 'antigravity_cli' && p.keys.length > 0}
        />
        <ProviderField
          label="MODEL"
          value={p.models.length ? p.models.map((m) => m.model_name).join(', ') : 'chưa có model'}
          tone="var(--color-neutral-300)"
        />
      </div>
      <div className="apm-provider__foot">
        {canManage && p.kind !== 'antigravity_cli' ? (
          <Button variant="ghost" className="btn-22" icon="ph ph-key" onClick={onAddKey}>
            Thêm khoá
          </Button>
        ) : null}
        <Button variant="secondary" className="btn-22" icon="ph ph-pulse" loading={test.isPending && test.variables === p.id} onClick={() => test.mutate(p.id)}>
          Kiểm tra kết nối
        </Button>
        {canManage ? (
          <Switch checked={p.enabled} label={`${p.enabled ? 'Tắt' : 'Bật'} ${p.name}`} disabled={setEnabled.isPending} onChange={(v) => setEnabled.mutate({ id: p.id, enabled: v })} />
        ) : null}
      </div>
      {lastResult ? (
        <div className={lastResult.ok ? 'apm-test-result apm-test-result--ok' : 'apm-test-result apm-test-result--bad'} role="status">
          {lastResult.ok ? `Kết nối được · độ trễ ${lastResult.latency_ms} ms` : lastResult.error}
        </div>
      ) : null}
      {testErr ? <InlineError>{errorText(testErr)}</InlineError> : null}
    </article>
  );
}

function ProviderField({ label, value, tone, secret }: { label: string; value: string; tone: string; secret?: boolean }) {
  return (
    <div className="apm-field">
      <span className="apm-field__key">{label}</span>
      <div className="apm-field__box">
        <span className="apm-field__val" style={{ color: tone }}>
          {value}
        </span>
        {secret ? <Icon name="ph ph-eye" size={13} color="var(--color-neutral-700)" /> : null}
      </div>
    </div>
  );
}

function BindingsPanel({ canManage }: { canManage: boolean }) {
  const bindings = useBindings();
  const [editing, setEditing] = useState<AgentBindingSlot | null>(null);
  return (
    <Panel
      title="Gán model cho từng agent"
      kicker="Agent nào dùng model nào, với quy tắc nào"
      label="Gán model cho từng agent"
      bodyClass="apm-table-wrap"
    >
      {bindings.isPending ? (
        <SkeletonLines rows={5} padding="10px 16px" />
      ) : bindings.isError ? (
        <CardError error={bindings.error} onRetry={() => void bindings.refetch()} retrying={bindings.isFetching} />
      ) : bindings.data.items.length === 0 ? (
        <EmptyState icon="ph ph-git-branch" title="Chưa có agent nào để gán model" />
      ) : (
        <table className="apm-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Model</th>
              <th>Bộ quy tắc</th>
              <th>Nhiệt độ</th>
              <th>Ngữ cảnh</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {bindings.data.items.map((slot) => (
              <tr key={slot.agent_key}>
                <td>
                  <span className="apm-table__agent">{slot.label}</span>
                </td>
                <td>
                  {canManage ? (
                    <button type="button" className="apm-model-pill" onClick={() => setEditing(slot)}>
                      {slot.binding?.model_name ?? 'chưa gán'}
                      <Icon name="ph ph-caret-down" size={10} />
                    </button>
                  ) : (
                    <span>{slot.binding?.model_name ?? 'chưa gán'}</span>
                  )}
                </td>
                <td className="mono">{slot.binding?.rule_codes.length ? slot.binding.rule_codes.join(', ') : '—'}</td>
                <td className="mono">{slot.binding ? fmtTemperature(slot.binding.temperature) : '—'}</td>
                <td className="mono">{slot.binding ? fmtContextTokens(slot.binding.context_tokens) : '—'}</td>
                <td>
                  {canManage && slot.binding ? (
                    <RemoveBindingButton agentKey={slot.agent_key} />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing ? <BindingEditDialog slot={editing} models={bindings.data?.models ?? []} onClose={() => setEditing(null)} /> : null}
    </Panel>
  );
}

function RemoveBindingButton({ agentKey }: { agentKey: string }) {
  const remove = useRemoveBinding();
  return (
    <Button variant="ghost" className="btn-22" icon="ph ph-x" loading={remove.isPending} aria-label="Bỏ gán model" onClick={() => remove.mutate(agentKey)} />
  );
}

function BindingEditDialog({ slot, models, onClose }: { slot: AgentBindingSlot; models: { id: string; model_name: string; provider_name: string; enabled: boolean }[]; onClose: () => void }) {
  const set = useSetBinding();
  const [modelId, setModelId] = useState(slot.binding?.model_id ?? models[0]?.id ?? '');
  const [temperature, setTemperature] = useState(String(slot.binding?.temperature ?? 0.3));
  const [contextTokens, setContextTokens] = useState(String(slot.binding?.context_tokens ?? 8000));
  const [ruleCodes, setRuleCodes] = useState((slot.binding?.rule_codes ?? []).join(', '));
  const submit = () => {
    if (!modelId) return;
    set.mutate(
      {
        agentKey: slot.agent_key,
        body: {
          model_id: modelId,
          temperature: Number(temperature),
          context_tokens: Number(contextTokens),
          rule_codes: ruleCodes
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={420}
      title={`Gán model cho ${slot.label}`}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="primary" loading={set.isPending} disabled={!modelId} onClick={submit}>
            Lưu
          </Button>
        </>
      }
    >
      <form
        className="dlg-fields"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {models.length === 0 ? (
          <p className="muted-note">Chưa có model nào — thêm model ở thẻ nhà cung cấp trước.</p>
        ) : (
          <SelectField
            label="Model"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            options={models.map((m) => ({ value: m.id, label: `${m.provider_name} · ${m.model_name}${m.enabled ? '' : ' (đã tắt)'}` }))}
          />
        )}
        <TextField label="Nhiệt độ (0–2)" type="number" step="0.05" min={0} max={2} value={temperature} onChange={(e) => setTemperature(e.target.value)} />
        <TextField label="Ngữ cảnh (token)" type="number" min={256} value={contextTokens} onChange={(e) => setContextTokens(e.target.value)} />
        <TextField label="Bộ quy tắc (mã, cách nhau dấu phẩy)" value={ruleCodes} onChange={(e) => setRuleCodes(e.target.value)} placeholder="R-01, R-02" />
        {set.isError ? <InlineError>{errorText(set.error)}</InlineError> : null}
      </form>
    </Dialog>
  );
}

function CoreParamsPanel() {
  const bindings = useBindings();
  const core = bindings.data?.items.find((i) => i.agent_key === 'core.refinery')?.binding ?? null;
  const rows: Array<[string, string]> = core
    ? [
        ['Model', `${core.provider_name} · ${core.model_name}`],
        ['Nhiệt độ', fmtTemperature(core.temperature)],
        ['Ngữ cảnh', fmtContextTokens(core.context_tokens)],
        ['Bộ quy tắc', core.rule_codes.length ? core.rule_codes.join(', ') : '—'],
      ]
    : [];
  return (
    <Panel title="Tham số core agent" kicker="Dùng cho việc sàng lọc thô → sạch" bodyClass="apm-params" label="Tham số core agent">
      {bindings.isPending ? (
        <SkeletonLines rows={4} padding="0" />
      ) : bindings.isError ? (
        <CardError error={bindings.error} onRetry={() => void bindings.refetch()} retrying={bindings.isFetching} />
      ) : !core ? (
        <EmptyState icon="ph ph-brain" title="Chưa gán model cho core agent" description="Gán ở bảng bên trên, khoá agent_key core.refinery." />
      ) : (
        rows.map(([k, v]) => (
          <div className="apm-param-row" key={k}>
            <span className="apm-param-row__key">{k}</span>
            <div className="apm-param-row__box">{v}</div>
          </div>
        ))
      )}
    </Panel>
  );
}

function RateLimitsPanel() {
  const providers = useProviders();
  const rows = (providers.data ?? []).flatMap((p) => p.models.map((m) => ({ key: `${p.id}-${m.id}`, label: `${p.name} · ${m.model_name}`, quota: fmtQuota(m.used_today, m.daily_quota) })));
  return (
    <Panel title="Giới hạn gọi API" kicker="Rate limit · bảo vệ hạn mức" bodyClass="apm-rates" label="Giới hạn gọi API">
      {providers.isPending ? (
        <SkeletonLines rows={4} padding="8px 16px" />
      ) : providers.isError ? (
        <CardError error={providers.error} onRetry={() => void providers.refetch()} retrying={providers.isFetching} />
      ) : rows.length === 0 ? (
        <EmptyState icon="ph ph-gauge" title="Chưa có model nào" />
      ) : (
        rows.map((r) => (
          <div className="apm-rate-row" key={r.key}>
            <span className="apm-rate-row__label">{r.label}</span>
            <span className="apm-rate-row__value mono">{r.quota}</span>
          </div>
        ))
      )}
    </Panel>
  );
}

function PriorityChainPanel({ canManage }: { canManage: boolean }) {
  const providers = useProviders();
  const reorder = useReorderChain();
  const [dragId, setDragId] = useState<string | null>(null);
  const list = [...(providers.data ?? [])].sort((a, b) => a.failover_rank - b.failover_rank);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= list.length || from === to) return;
    const ids = list.map((p) => p.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    reorder.mutate(ids);
  };

  const onDrop = (e: DragEvent, index: number) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragId;
    setDragId(null);
    if (!id) return;
    const from = list.findIndex((p) => p.id === id);
    if (from < 0) return;
    move(from, index);
  };

  return (
    <Panel title="Chuỗi ưu tiên" kicker="Kéo để đổi thứ tự — hoặc dùng nút lên/xuống" bodyClass="apm-chain" label="Chuỗi ưu tiên nhà cung cấp">
      {providers.isPending ? (
        <SkeletonLines rows={3} padding="10px 16px" />
      ) : providers.isError ? (
        <CardError error={providers.error} onRetry={() => void providers.refetch()} retrying={providers.isFetching} />
      ) : list.length === 0 ? (
        <EmptyState icon="ph ph-arrows-down-up" title="Chưa có nhà cung cấp nào" />
      ) : (
        <ol className="apm-chain-list" aria-label="Chuỗi ưu tiên nhà cung cấp">
          {list.map((p, i) => (
            <li
              key={p.id}
              className="apm-chain-row"
              draggable={canManage}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', p.id);
                e.dataTransfer.effectAllowed = 'move';
                setDragId(p.id);
              }}
              onDragOver={(e) => canManage && e.preventDefault()}
              onDrop={(e) => canManage && onDrop(e, i)}
            >
              {canManage ? <Icon name="ph ph-dots-six-vertical" size={15} color="var(--color-neutral-700)" /> : null}
              <span className="apm-chain-row__rank mono">{i + 1}</span>
              <div className="apm-chain-row__body">
                <div className="apm-chain-row__name">{p.name}</div>
                <div className="apm-chain-row__model mono">{p.models[0]?.model_name ?? '—'}</div>
              </div>
              <span className="apm-chain-row__state" style={{ color: p.auth_state === 'ok' ? 'var(--color-ok)' : 'var(--color-neutral-500)' }}>
                {p.enabled ? 'đang bật' : 'đã tắt'}
              </span>
              {canManage ? (
                <span className="apm-chain-row__keys">
                  <Button variant="ghost" className="btn-22" icon="ph ph-caret-up" aria-label={`Đưa ${p.name} lên trước`} disabled={i === 0 || reorder.isPending} onClick={() => move(i, i - 1)} />
                  <Button
                    variant="ghost"
                    className="btn-22"
                    icon="ph ph-caret-down"
                    aria-label={`Đưa ${p.name} xuống sau`}
                    disabled={i === list.length - 1 || reorder.isPending}
                    onClick={() => move(i, i + 1)}
                  />
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {reorder.isError ? <InlineError>{errorText(reorder.error)}</InlineError> : null}
    </Panel>
  );
}

function FailoverRulesPanel() {
  const rules = useFailoverRules();
  return (
    <Panel title="Quy tắc chuyển hướng" kicker="Failover rules — cố định" bodyClass="apm-rules" label="Quy tắc chuyển hướng">
      {rules.isPending ? (
        <SkeletonLines rows={4} padding="8px 16px" />
      ) : rules.isError ? (
        <CardError error={rules.error} onRetry={() => void rules.refetch()} retrying={rules.isFetching} />
      ) : (
        rules.data.map((r) => (
          <div className="apm-rule-row" key={r.key}>
            <span className="apm-rule-row__key mono">{r.key}</span>
            <span className="apm-rule-row__val">{r.value}</span>
          </div>
        ))
      )}
    </Panel>
  );
}

function AddProviderDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateProvider();
  const [kind, setKind] = useState<'gemini' | 'deepseek' | 'openai_compat'>('gemini');
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [keys, setKeys] = useState('');
  const [models, setModels] = useState('');
  const submit = () => {
    const keyList = keys.split('\n').map((k) => k.trim()).filter(Boolean);
    if (!name.trim() || !keyList.length || (kind === 'openai_compat' && !endpoint.trim())) return;
    create.mutate(
      {
        kind,
        name: name.trim(),
        endpoint: endpoint.trim() || undefined,
        keys: keyList,
        models: models
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={440}
      title="Thêm nhà cung cấp"
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            Thêm
          </Button>
        </>
      }
    >
      <form
        className="dlg-fields"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <SelectField
          label="Loại"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          options={[
            { value: 'gemini', label: 'Gemini API' },
            { value: 'deepseek', label: 'DeepSeek API' },
            { value: 'openai_compat', label: 'API tương thích OpenAI' },
          ]}
        />
        <TextField label="Tên hiển thị" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        {kind === 'openai_compat' ? <TextField label="Endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://…" /> : null}
        <div className="gh-field">
          <label className="gh-field__label" htmlFor="apm-new-keys">
            Khoá API (mỗi dòng một khoá)
          </label>
          <textarea id="apm-new-keys" className="gh-input" rows={2} value={keys} onChange={(e) => setKeys(e.target.value)} />
        </div>
        <TextField label="Model ban đầu (tuỳ chọn, cách nhau dấu phẩy)" value={models} onChange={(e) => setModels(e.target.value)} placeholder="gemini-2.5-flash" />
        {create.isError ? <InlineError>{errorText(create.error)}</InlineError> : null}
      </form>
    </Dialog>
  );
}

function AddKeyDialog({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const addKey = useAddProviderKey();
  const addModel = useAddModel();
  const [secret, setSecret] = useState('');
  const [modelName, setModelName] = useState('');
  const submit = () => {
    if (!secret.trim() || secret.trim().length < 8) return;
    addKey.mutate(
      { id: provider.id, secret: secret.trim() },
      {
        onSuccess: () => {
          if (modelName.trim()) addModel.mutate({ id: provider.id, body: { model_name: modelName.trim() } });
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={400}
      title={`Thêm khoá cho ${provider.name}`}
      kicker="Chỉ hiện 4 ký tự cuối sau khi lưu"
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="primary" loading={addKey.isPending} disabled={secret.trim().length < 8} onClick={submit}>
            Thêm khoá
          </Button>
        </>
      }
    >
      <form
        className="dlg-fields"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField label="Khoá API mới" value={secret} onChange={(e) => setSecret(e.target.value)} revealable autoComplete="off" spellCheck={false} />
        <TextField label="Model đi kèm (tuỳ chọn)" value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="gemini-2.5-flash" />
        {addKey.isError ? <InlineError>{errorText(addKey.error)}</InlineError> : null}
      </form>
    </Dialog>
  );
}
