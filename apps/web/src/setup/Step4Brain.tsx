import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Provider, ProviderKind, ProviderTestResult } from '@gen-harness/contracts';
import { Button, EmptyState, IconButton, SelectField, TextField } from '@gen-harness/ui';
import { api } from '../lib/api';
import { qk2, useCliProfiles, useProviders } from '../lib/dataQueries';
import { emailInitials, fmtInt, fmtLatency } from '../lib/format';
import { queryClient } from '../lib/queryClient';
import { useNow } from '../lib/useNow';
import { errorText } from '../lib/errorText';
import { CardError, InlineError, SkeletonLines, StateChip } from '../screens/common';
import { CliLoginPanel } from '../screens/system/CliCard';
import { useCliLogin } from '../screens/system/useCliLogin';
import { cliChip, cliMeta } from '../screens/system/systemModel';
import { providerReady } from './phase2Model';
import { StepFrame } from './StepFrame';
import { describeError, type StepProps } from './types';

const KINDS: Array<{ value: Exclude<ProviderKind, 'antigravity_cli'>; label: string; name: string }> = [
  { value: 'gemini', label: 'Gemini API', name: 'Gemini API' },
  { value: 'deepseek', label: 'DeepSeek API', name: 'DeepSeek API' },
  { value: 'openai_compat', label: 'Tương thích OpenAI', name: '' },
];

const AUTH_LABEL: Record<Provider['auth_state'], { label: string; tone: string }> = {
  ok: { label: 'Hoạt động', tone: 'var(--color-ok)' },
  expiring: { label: 'Sắp hết hạn', tone: 'var(--color-warn)' },
  expired: { label: 'Hết hạn', tone: 'var(--color-bad)' },
  error: { label: 'Lỗi', tone: 'var(--color-bad)' },
  unconfigured: { label: 'Chưa cấu hình', tone: 'var(--color-neutral-400)' },
};

export function Step4Brain({ meta, description, onBack, onSaved, formRef }: StepProps) {
  const providers = useProviders();
  const profiles = useCliProfiles();
  const login = useCliLogin();
  const now = useNow(60_000);
  const [tested, setTested] = useState<Record<string, ProviderTestResult>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const list = useMemo(() => providers.data ?? [], [providers.data]);
  // Keep the local order in sync with the server list (new providers go last).
  useEffect(() => {
    setOrder((prev) => {
      const ids = [...list].sort((a, b) => a.failover_rank - b.failover_rank).map((p) => p.id);
      const kept = prev.filter((id) => ids.includes(id));
      return [...kept, ...ids.filter((id) => !kept.includes(id))];
    });
  }, [list]);
  const ordered = order.map((id) => list.find((p) => p.id === id)).filter((p): p is Provider => !!p);

  const activeProfile = profiles.data?.find((p) => p.active);
  const cliActive = !!activeProfile && activeProfile.state !== 'expired';
  const ready = ordered.filter((p) => providerReady(p, tested, cliActive));
  const canContinue = ready.length > 0 || (cliActive && ordered.length === 0);

  const test = useMutation({
    mutationFn: (id: string) => api.providers.test(id),
    onSuccess: (r, id) => setTested((t) => ({ ...t, [id]: r })),
    onError: (e, id) => setTested((t) => ({ ...t, [id]: { ok: false, latency_ms: null, models: [], error: errorText(e) } })),
  });

  const move = (i: number, d: -1 | 1) =>
    setOrder((o) => {
      const j = i + d;
      if (j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const save = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const ids = ordered.filter((p) => providerReady(p, tested, cliActive)).map((p) => p.id);
      onSaved(await api.setup.step4(ids));
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const chip = cliChip(activeProfile);

  return (
    <StepFrame
      n={meta.n}
      title={meta.title}
      description={description}
      formRef={formRef}
      canContinue={canContinue}
      busy={busy}
      onContinue={() => void save()}
      onBack={onBack}
      formError={formError}
    >
      <div className="setup-section">
        <div className="setup-section__title">Antigravity CLI · tài khoản Google</div>
        {profiles.isPending ? (
          <SkeletonLines rows={1} padding="0" />
        ) : profiles.isError ? (
          <CardError error={profiles.error} onRetry={() => void profiles.refetch()} retrying={profiles.isFetching} />
        ) : (
          <div className="setup-row">
            <div className={activeProfile ? 'cli-avatar' : 'cli-avatar cli-avatar--empty'} aria-hidden>
              {activeProfile ? emailInitials(activeProfile.email) : '—'}
            </div>
            <div className="setup-row__main">
              <div className="setup-row__title">{activeProfile ? activeProfile.email : 'Chưa đăng nhập'}</div>
              <div className="cli-meta">
                {activeProfile ? cliMeta(activeProfile, now) : 'Đăng nhập Google trong container để core agent dùng Antigravity CLI.'}
              </div>
            </div>
            <StateChip color={chip.tone} border={chip.tone === 'var(--color-neutral-400)' ? 'var(--color-neutral-800)' : chip.tone} dot size="md">
              {chip.label}
            </StateChip>
            {!login.active ? (
              <Button variant={activeProfile ? 'secondary' : 'primary'} className="btn-28" icon="ph ph-user-switch" onClick={() => login.start.mutate()}>
                {activeProfile ? 'Thêm tài khoản' : 'Đăng nhập'}
              </Button>
            ) : null}
          </div>
        )}
        <CliLoginPanel login={login} />
      </div>

      <div className="setup-section">
        <div className="setup-section__title">Khoá API · chuỗi chuyển hướng</div>
        <p className="setup-section__hint">Nguồn đứng trên được dùng trước; khi cạn hạn mức hoặc lỗi, core agent chuyển xuống nguồn kế tiếp.</p>
        {providers.isPending ? (
          <SkeletonLines rows={2} padding="0" />
        ) : providers.isError ? (
          <CardError error={providers.error} onRetry={() => void providers.refetch()} retrying={providers.isFetching} />
        ) : ordered.length === 0 ? (
          <EmptyState icon="ph ph-key" title="Chưa có nguồn model nào" description="Đăng nhập CLI ở trên hoặc thêm một khoá API bên dưới." />
        ) : (
          <div className="prov-list" aria-label="Chuỗi chuyển hướng">
            {ordered.map((p, i) => {
              const auth = AUTH_LABEL[p.auth_state] ?? AUTH_LABEL.unconfigured;
              const t = tested[p.id];
              const testing = test.isPending && test.variables === p.id;
              return (
                <div className="prov-row" key={p.id}>
                  <span className="prov-rank">{i + 1}.</span>
                  <div className="setup-row__main">
                    <div className="setup-row__title">{p.name}</div>
                    <div className="setup-row__meta">
                      {p.kind === 'antigravity_cli'
                        ? 'Antigravity CLI'
                        : `${fmtInt(p.keys.length)} khoá${p.keys[0] ? ` · …${p.keys[0].last4}` : ''}`}
                      {p.models.length ? ` · ${p.models.map((m) => m.model_name).join(', ')}` : ''}
                    </div>
                    {t ? (
                      <div className="prov-test" style={{ color: t.ok ? 'var(--color-ok)' : 'var(--color-bad)' }} role="status">
                        {t.ok
                          ? `Gọi thử OK · ${fmtLatency(t.latency_ms)}${t.models.length ? ` · ${t.models.join(', ')}` : ''}`
                          : `Lỗi: ${t.error ?? 'không gọi được'}`}
                      </div>
                    ) : null}
                    {t?.ok && p.kind !== 'antigravity_cli' && !p.models.length && t.models.length ? <AddModel provider={p} models={t.models} /> : null}
                  </div>
                  <StateChip color={auth.tone} border={auth.tone === 'var(--color-neutral-400)' ? 'var(--color-neutral-800)' : auth.tone}>
                    {auth.label}
                  </StateChip>
                  <Button variant="secondary" className="btn-27" loading={testing} onClick={() => test.mutate(p.id)}>
                    Kiểm tra
                  </Button>
                  <IconButton icon="ph ph-arrow-up" label={`Đưa ${p.name} lên trước`} disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton icon="ph ph-arrow-down" label={`Đưa ${p.name} xuống sau`} disabled={i === ordered.length - 1} onClick={() => move(i, 1)} />
                </div>
              );
            })}
          </div>
        )}
        <AddProvider onAdded={(p) => test.mutate(p.id)} />
      </div>
    </StepFrame>
  );
}

function AddProvider({ onAdded }: { onAdded: (p: Provider) => void }) {
  const [kind, setKind] = useState<(typeof KINDS)[number]['value']>('gemini');
  const [name, setName] = useState('Gemini API');
  const [endpoint, setEndpoint] = useState('');
  const [key, setKey] = useState('');
  const add = useMutation({
    mutationFn: () =>
      api.providers.create({
        kind,
        name: name.trim() || KINDS.find((k) => k.value === kind)!.label,
        ...(kind === 'openai_compat' ? { endpoint: endpoint.trim() } : {}),
        keys: [key.trim()],
      }),
    onSuccess: (p) => {
      queryClient.setQueryData<Provider[]>(qk2.providers, (old) => (old ? [...old.filter((x) => x.id !== p.id), p] : [p]));
      setKey('');
      onAdded(p);
    },
  });
  const valid = key.trim().length >= 8 && (kind !== 'openai_compat' || /^https?:\/\//.test(endpoint.trim()));
  return (
    <div className="dlg-fields" style={{ gap: 10 }}>
      <div className="prov-add">
        <SelectField
          label="Loại"
          value={kind}
          options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
          onChange={(e) => {
            const k = e.target.value as typeof kind;
            setKind(k);
            setName(KINDS.find((x) => x.value === k)!.name);
          }}
        />
        <TextField label="Tên hiển thị" value={name} onChange={(e) => setName(e.target.value)} />
        {kind === 'openai_compat' ? (
          <TextField label="Endpoint" placeholder="https://…/v1" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
        ) : null}
        <TextField
          label="Khoá API"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (valid) add.mutate();
            }
          }}
        />
      </div>
      <div className="dlg-row">
        <Button variant="secondary" icon="ph ph-plus" disabled={!valid} loading={add.isPending} onClick={() => add.mutate()}>
          Thêm & kiểm tra
        </Button>
        <span className="muted-note">Khoá được mã hoá trong két; Console chỉ hiện 4 ký tự cuối.</span>
      </div>
      {add.isError ? <InlineError>{errorText(add.error)}</InlineError> : null}
    </div>
  );
}

/** Bước 4: pick the model the brain uses on a freshly tested provider (`POST /providers/{id}/models`). */
function AddModel({ provider, models }: { provider: Provider; models: string[] }) {
  const [model, setModel] = useState(models[0]);
  const add = useMutation({
    mutationFn: () => api.providers.addModel(provider.id, { model_name: model }),
    onSuccess: (next) => queryClient.setQueryData<Provider[]>(qk2.providers, (old) => old?.map((x) => (x.id === next.id ? next : x))),
  });
  return (
    <div className="prov-model">
      <select className="mini-select" aria-label={`Model cho ${provider.name}`} value={model} onChange={(e) => setModel(e.target.value)}>
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <Button variant="secondary" size="sm" loading={add.isPending} onClick={() => add.mutate()}>
        Dùng model này
      </Button>
      {add.isError ? <span className="prov-model__err">{errorText(add.error)}</span> : null}
    </div>
  );
}


