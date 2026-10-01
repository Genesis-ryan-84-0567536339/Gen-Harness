import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { CliKind, Provider, ProviderKind, ProviderTestResult } from '@gen-harness/contracts';
import { Button, Dialog, EmptyState, Icon, IconButton, SelectField, TextField } from '@gen-harness/ui';
import { api } from '../lib/api';
import { qk2, useCliProfiles, useProviders } from '../lib/dataQueries';
import { emailInitials, fmtDMClock, fmtInt, fmtLatency } from '../lib/format';
import { queryClient } from '../lib/queryClient';
import { useNow } from '../lib/useNow';
import { errorText } from '../lib/errorText';
import { CardError, FriendlyErrorText, InlineError, SkeletonLines, StateChip } from '../screens/common';
import { PROVIDER_KIND_LABEL, choiceText, isCliKind, providerStatus, testOkText } from '../screens/api/apiModel';
import { ModelPicker } from '../screens/api/ModelPicker';
import { ClaudeRiskNotice, CliLoginPanel } from '../screens/system/CliCard';
import { CliDiagnose } from '../screens/system/CliDiagnose';
import { useCliLogin } from '../screens/system/useCliLogin';
import { CLI_TEXT, cliAccountLabel, cliChip, cliMeta } from '../screens/system/systemModel';
import { providerHasModel, providerReady, testedModels } from './phase2Model';
import { StepFrame } from './StepFrame';
import { describeError, type StepProps } from './types';

const KINDS: Array<{ value: Exclude<ProviderKind, CliKind | 'system_one'>; label: string; name: string }> = [
  { value: 'gemini', label: 'Gemini API', name: 'Gemini API' },
  { value: 'deepseek', label: 'DeepSeek API', name: 'DeepSeek API' },
  { value: 'openai_compat', label: 'Tương thích OpenAI', name: '' },
];

const N8 = 'var(--color-neutral-800)';
const N4 = 'var(--color-neutral-400)';
const N5 = 'var(--color-neutral-500)';

export function Step4Brain({ meta, description, onBack, onSaved, formRef, onSkip, skipping, skipError }: StepProps) {
  const providers = useProviders();
  const profiles = useCliProfiles();
  const claudeProfiles = useCliProfiles('claude_code_cli');
  const [tested, setTested] = useState<Record<string, ProviderTestResult>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // v0.1.29 (Boss 30/09): "Để sau" được, nhưng phải qua hộp cảnh báo nói rõ hậu quả.
  const [confirmSkip, setConfirmSkip] = useState(false);

  // Jev (system_one) is not a text model — it never goes into the chain (same filter as the server).
  const list = useMemo(() => (providers.data ?? []).filter((p) => p.kind !== 'system_one'), [providers.data]);
  // Keep the local order in sync with the server list (new providers go last).
  useEffect(() => {
    setOrder((prev) => {
      const ids = [...list].sort((a, b) => a.failover_rank - b.failover_rank).map((p) => p.id);
      const kept = prev.filter((id) => ids.includes(id));
      return [...kept, ...ids.filter((id) => !kept.includes(id))];
    });
  }, [list]);

  const activeProfile = profiles.data?.find((p) => p.active);
  const claudeActive = claudeProfiles.data?.find((p) => p.active);
  const cliActive = {
    antigravity_cli: !!activeProfile && activeProfile.state !== 'expired',
    claude_code_cli: !!claudeActive && claudeActive.state !== 'expired',
  };
  const byOrder = order.map((id) => list.find((p) => p.id === id)).filter((p): p is Provider => !!p);
  // v0.1.28 (UX N1): nguồn chưa gọi được (lỗi / chưa kiểm tra) luôn đứng SAU nguồn dùng được — không bao giờ đầu chuỗi.
  const ready = byOrder.filter((p) => providerReady(p, tested, cliActive));
  const notReady = byOrder.filter((p) => !ready.includes(p));
  const ordered = [...ready, ...notReady];
  // v0.1.28 (UX C1): chỉ cho Tiếp tục khi có nguồn dùng được CÓ model (đã chọn, hoặc máy chủ tự lấy model đầu tiên).
  const withModel = ready.filter((p) => providerHasModel(p, tested));
  const canContinue = withModel.length > 0;
  const blockReason = canContinue
    ? null
    : ready.length
      ? 'Chọn model cho nguồn đã kiểm tra OK (bấm "Kiểm tra" rồi "Dùng model này") để tiếp tục.'
      : 'Cần ít nhất một nguồn gọi thử thành công để tiếp tục.';

  const refreshProviders = () => void queryClient.invalidateQueries({ queryKey: qk2.providers });
  const test = useMutation({
    mutationFn: (id: string) => api.providers.test(id),
    onSuccess: (r, id) => {
      setTested((t) => ({ ...t, [id]: r }));
      refreshProviders(); // trạng thái (Hoạt động / Lỗi kết nối) do máy chủ ghi — đọc lại cho khớp mọi màn
    },
    onError: (e, id) => setTested((t) => ({ ...t, [id]: { ok: false, latency_ms: null, models: [], error: errorText(e) } })),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.providers.remove(id),
    onSuccess: (_r, id) => {
      queryClient.setQueryData<Provider[]>(qk2.providers, (old) => old?.filter((x) => x.id !== id));
      setTested(({ [id]: _drop, ...rest }) => rest);
      refreshProviders();
    },
  });

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= ordered.length) return;
    const next = ordered.map((p) => p.id);
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  };

  const save = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const state = await api.setup.step4(ready.map((p) => p.id));
      // Máy chủ có thể vừa tự chọn model + xếp lại thứ tự — đọc lại cho bước 12 và các màn khác.
      void queryClient.invalidateQueries({ queryKey: qk2.providers });
      onSaved(state);
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

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
      onSkip={onSkip ? () => setConfirmSkip(true) : undefined}
      skipping={skipping}
      formError={formError ?? skipError}
      blockedHint={providers.data ? blockReason : null}
    >
      {onSkip ? (
        <SkipBrainDialog
          open={confirmSkip}
          hasTestedModel={canContinue}
          onClose={() => setConfirmSkip(false)}
          onConfirm={() => {
            setConfirmSkip(false);
            onSkip();
          }}
        />
      ) : null}
      <CliAccountSection kind="antigravity_cli" />
      <CliAccountSection kind="claude_code_cli" />

      <div className="setup-section">
        <div className="setup-section__title">Khoá API · thứ tự dùng</div>
        <p className="setup-section__hint">Nguồn đứng trên được dùng trước; khi hết hạn mức hoặc lỗi, hệ thống chuyển xuống nguồn kế tiếp. Nguồn chưa gọi được luôn xếp cuối.</p>
        {providers.isPending ? (
          <SkeletonLines rows={2} padding="0" />
        ) : providers.isError ? (
          <CardError error={providers.error} onRetry={() => void providers.refetch()} retrying={providers.isFetching} />
        ) : ordered.length === 0 ? (
          <EmptyState icon="ph ph-key" title="Chưa có nguồn model nào" description="Đăng nhập Google ở trên hoặc thêm một khoá API bên dưới." />
        ) : (
          <div className="prov-list" aria-label="Chuỗi chuyển hướng">
            {ordered.map((p, i) => {
              const status = providerStatus(p);
              const isReady = i < ready.length;
              const t = tested[p.id] ?? p.last_test ?? null;
              const offered = testedModels(p, tested);
              const testing = test.isPending && test.variables === p.id;
              return (
                <div className="prov-row" key={p.id} data-ready={isReady || undefined}>
                  <span className="prov-rank">{isReady ? `${i + 1}.` : '–'}</span>
                  <div className="setup-row__main">
                    <div className="setup-row__title">{p.name}</div>
                    <div className="setup-row__meta">
                      {isCliKind(p.kind)
                        ? PROVIDER_KIND_LABEL[p.kind]
                        : `${fmtInt(p.keys.length)} khoá${p.keys[0] ? ` · …${p.keys[0].last4}` : ''}`}
                      {p.models.length ? ` · ${p.models.map((m) => choiceText(m.model_name, m.effort)).join(', ')}` : ''}
                    </div>
                    {t ? (
                      <div className="prov-test" style={{ color: t.ok ? 'var(--color-ok)' : 'var(--color-bad)' }} role="status">
                        {t.ok ? (
                          testOkText(t, fmtLatency)
                        ) : (
                          <>
                            <FriendlyErrorText raw={t.error} prefix="Chưa dùng được: " fallback="không gọi được nguồn này." />
                            {t.at ? ` (lúc ${fmtDMClock(t.at)})` : null}
                            {t.error_detail || t.models_raw ? (
                              <details className="tech-detail">
                                <summary>Chi tiết kỹ thuật</summary>
                                <code>{[t.error_detail, t.models_raw ? `agy models:\n${t.models_raw}` : null].filter(Boolean).join('\n\n')}</code>
                              </details>
                            ) : null}
                          </>
                        )}
                      </div>
                    ) : null}
                    {isReady && offered.length ? <ModelPicker provider={p} test={t} /> : null}
                    {isCliKind(p.kind) ? <CliDiagnose provider={p} /> : null}
                  </div>
                  <StateChip color={status.tone} border={status.tone === N5 || status.tone === N4 ? N8 : status.tone}>
                    {status.label}
                  </StateChip>
                  <Button variant="secondary" className="btn-27" loading={testing} onClick={() => test.mutate(p.id)}>
                    Kiểm tra
                  </Button>
                  <IconButton icon="ph ph-arrow-up" label={`Đưa ${p.name} lên trước`} disabled={i === 0 || !isReady} onClick={() => move(i, -1)} />
                  <IconButton icon="ph ph-arrow-down" label={`Đưa ${p.name} xuống sau`} disabled={i >= ready.length - 1} onClick={() => move(i, 1)} />
                  {!isCliKind(p.kind) ? (
                    <IconButton
                      icon="ph ph-trash"
                      label={`Xoá ${p.name}`}
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(`Xoá nguồn "${p.name}"? Khoá API của nguồn này cũng bị xoá.`)) remove.mutate(p.id);
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {remove.isError ? <InlineError>{errorText(remove.error)}</InlineError> : null}
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
  const keyShort = key.trim().length > 0 && key.trim().length < 8;
  const endpointBad = kind === 'openai_compat' && endpoint.trim().length > 0 && !/^https?:\/\//.test(endpoint.trim());
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
          <TextField
            label="Địa chỉ gọi (Endpoint)"
            placeholder="https://…/v1"
            value={endpoint}
            error={endpointBad ? 'Địa chỉ cần bắt đầu bằng https:// (hoặc http://)' : null}
            onChange={(e) => setEndpoint(e.target.value)}
          />
        ) : null}
        <TextField
          label="Khoá API"
          type="password"
          autoComplete="off"
          value={key}
          error={keyShort ? 'Khoá API có vẻ quá ngắn — kiểm tra lại đã dán đủ chưa' : null}
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
        <span className="muted-note">Khoá được mã hoá khi lưu; Console chỉ hiện 4 ký tự cuối.</span>
      </div>
      {add.isError ? <InlineError>{errorText(add.error)}</InlineError> : null}
    </div>
  );
}

/** Hộp cảnh báo trước khi "Để sau" bước 4 — nói thẳng việc gì sẽ KHÔNG chạy khi chưa có model. */
export function SkipBrainDialog({
  open,
  hasTestedModel,
  onClose,
  onConfirm,
}: {
  open: boolean;
  hasTestedModel: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={460}
      title="Để sau bước Bộ não AI?"
      kicker="Chưa có model thì trợ lý chưa làm việc được"
      actions={
        <>
          <Button variant="secondary" onClick={onClose} data-autofocus>
            Quay lại chọn model
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Vẫn để sau
          </Button>
        </>
      }
    >
      <div className="dlg-fields">
        <div className="risk-box" role="note">
          <Icon name="ph ph-warning" size={16} color="var(--color-warn)" />
          <div className="risk-box__text">
            {hasTestedModel
              ? 'Đã có nguồn gọi thử thành công — hệ thống vẫn tự dùng model của nguồn đó, Sếp đổi lại sau được.'
              : 'Khi chưa chọn model: Gen (trợ lý) sẽ không trả lời và sàng lọc tin sẽ không chạy cho tới khi Sếp chọn model.'}
          </div>
        </div>
        <ul className="risk-list">
          <li>Tin nhắn vẫn được gom về kho thô, sẽ được lọc khi có model.</li>
          <li>Tổng quan sẽ hiện dải "Chưa có model" kèm nút Chọn model để làm lại bất cứ lúc nào.</li>
        </ul>
      </div>
    </Dialog>
  );
}

/**
 * Bước 4 · tài khoản CLI (v0.1.31): Antigravity (Google) và Claude Code (gói Claude, tuỳ chọn — QD-12 Owner tự quyết).
 * Hết hạn thật → nút "Đăng nhập lại"; token ngắn hạn quá giờ mà CLI tự gia hạn → "Đang hoạt động".
 */
function CliAccountSection({ kind }: { kind: CliKind }) {
  const profiles = useCliProfiles(kind);
  const login = useCliLogin(kind);
  const now = useNow(60_000);
  const txt = CLI_TEXT[kind];
  const active = profiles.data?.find((p) => p.active);
  const chip = cliChip(active);
  const claude = kind === 'claude_code_cli';
  return (
    <div className="setup-section" data-testid={`setup-cli-${kind}`}>
      <div className="setup-section__title">{claude ? 'Claude Code CLI · gói Claude (tuỳ chọn)' : 'Tài khoản Google · Antigravity CLI'}</div>
      {claude && !active ? <ClaudeRiskNotice /> : null}
      {profiles.isPending ? (
        <SkeletonLines rows={1} padding="0" />
      ) : profiles.isError ? (
        <CardError error={profiles.error} onRetry={() => void profiles.refetch()} retrying={profiles.isFetching} />
      ) : (
        <div className="setup-row">
          <div className={active ? 'cli-avatar' : 'cli-avatar cli-avatar--empty'} aria-hidden>
            {active ? emailInitials(active.email) : '—'}
          </div>
          <div className="setup-row__main">
            <div className="setup-row__title">{active ? cliAccountLabel(active) : claude ? 'Chưa bật' : 'Chưa đăng nhập'}</div>
            <div className="cli-meta">
              {active ? cliMeta(active, now) : claude ? txt.empty : 'Đăng nhập Google để hệ thống dùng AI qua tài khoản của Sếp.'}
            </div>
          </div>
          <StateChip color={chip.tone} border={chip.tone === N4 ? N8 : chip.tone} dot size="md">
            {chip.label}
          </StateChip>
          {!login.active ? (
            <Button
              variant={active && active.state !== 'expired' ? 'secondary' : 'primary'}
              className="btn-28"
              icon="ph ph-user-switch"
              onClick={() => login.start.mutate()}
            >
              {active?.state === 'expired' ? 'Đăng nhập lại' : active ? txt.add : txt.login}
            </Button>
          ) : null}
        </div>
      )}
      <CliLoginPanel login={login} />
    </div>
  );
}
