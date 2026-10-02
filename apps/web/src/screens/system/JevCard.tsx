import { useState } from 'react';
import type { Provider } from '@gen-harness/contracts';
import { Button, Icon, SelectField, TextField } from '@gen-harness/ui';
import { useProviders } from '../../lib/dataQueries';
import { errorText } from '../../lib/errorText';
import { useCan } from '../../lib/permissions';
import { useCreateProvider, useTestProvider } from '../api/queries';
import { providerStatus } from '../api/apiModel';
import { FriendlyErrorText, InlineError, Panel, PinHint, SkeletonLines } from '../common';

const JEV_BASE_URLS = [
  { value: 'https://openrouter.ai/api/v1', label: 'OpenRouter — openrouter.ai/api/v1' },
  { value: 'https://api.typesafe.ai', label: 'TypeSafe API — api.typesafe.ai' },
];
const JEV_DEFAULT_MODEL = 'typesafe/jev-1.13';

/**
 * Jev (TypeSafe System One) — nguồn model mới kind `system_one` (v0.1.21, quyết định §9.6): mô hình quyết định nhanh
 * Gen dùng để chọn ý định và bước UI kế tiếp (trần ~1,5 s, lỗi/chậm thì rơi về model lớn). Không nằm trong chuỗi
 * sinh chữ. Khoá lưu như khoá nhà cung cấp khác (mã hoá phong bì).
 */
export function JevCard() {
  const canManage = useCan('system.manage');
  const providers = useProviders();
  const jev = (providers.data ?? []).find((p) => p.kind === 'system_one');
  // Một mutation cho cả thẻ: "Lưu & kiểm tra" ở form, kết quả hiện tiếp ở phần trạng thái sau khi lưu.
  const test = useTestProvider();
  return (
    <Panel
      title="Jev — quyết định nhanh cho Gen"
      kicker="Giúp Gen chọn việc nhanh và rẻ hơn — không bắt buộc"
      label="Jev — quyết định nhanh cho Gen"
      genTarget="system.brain.jev"
      bodyClass="jev-body"
    >
      {providers.isPending ? (
        <SkeletonLines rows={3} padding="0" />
      ) : jev ? (
        <JevStatus p={jev} test={test} />
      ) : canManage ? (
        <JevForm test={test} />
      ) : (
        <p className="muted-note">Chưa cấu hình Jev — Gen dùng model lớn cho mọi quyết định.</p>
      )}
    </Panel>
  );
}

type TestMutation = ReturnType<typeof useTestProvider>;

function JevStatus({ p, test }: { p: Provider; test: TestMutation }) {
  const result = test.data && test.variables === p.id ? test.data : null;
  const status = providerStatus(p);
  const tone = status.tone;
  return (
    <>
      <dl className="jev-dl">
        <dt>Địa chỉ</dt>
        <dd className="mono">{p.endpoint}</dd>
        <dt>Model</dt>
        <dd className="mono">{p.models[0]?.model_name ?? '—'}</dd>
        <dt>Khoá</dt>
        <dd className="mono">{p.keys.length ? p.keys.map((k) => `${k.label} ····${k.last4}`).join(' · ') : 'chưa có khoá'}</dd>
        <dt>Trạng thái</dt>
        <dd style={{ color: tone }}>{status.label}</dd>
      </dl>
      <div className="jev-actions">
        <Button variant="secondary" className="btn-27" icon="ph ph-pulse" data-gen-target="system.brain.jev.test" loading={test.isPending} onClick={() => test.mutate(p.id)}>
          Kiểm tra
        </Button>
        <span className="jev-note">
          <Icon name="ph ph-info" size={12} /> Gen hỏi Jev trước (tối đa 1,5 giây); lỗi hoặc chậm thì dùng model lớn.
        </span>
      </div>
      {result ? (
        <div className={result.ok ? 'apm-test-result apm-test-result--ok' : 'apm-test-result apm-test-result--bad'} role="status">
          {result.ok ? `Jev trả lời được · ${result.latency_ms} ms` : <FriendlyErrorText raw={result.error} />}
        </div>
      ) : null}
      {test.isError ? <InlineError>{errorText(test.error)}</InlineError> : null}
    </>
  );
}

function JevForm({ test }: { test: TestMutation }) {
  const create = useCreateProvider();
  const [base, setBase] = useState(JEV_BASE_URLS[0].value);
  const [model, setModel] = useState(JEV_DEFAULT_MODEL);
  const [key, setKey] = useState('');
  const valid = key.trim().length >= 8 && model.trim().length > 0;
  const save = () => {
    if (!valid) return;
    create.mutate(
      { kind: 'system_one', name: 'Jev (System One)', endpoint: base, keys: [key.trim()], models: [model.trim()] },
      { onSuccess: (p) => test.mutate(p.id) },
    );
  };
  return (
    <form
      className="jev-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <SelectField label="Địa chỉ gọi" value={base} onChange={(e) => setBase(e.target.value)} options={JEV_BASE_URLS} />
      <TextField label="Model" value={model} onChange={(e) => setModel(e.target.value)} className="mono" />
      <TextField label="Khoá API" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-or-…" />
      <div className="jev-actions">
        <Button variant="primary" type="submit" className="btn-27" icon="ph ph-floppy-disk" disabled={!valid} loading={create.isPending} data-gen-target="system.brain.jev.test">
          Lưu &amp; kiểm tra
        </Button>
        <PinHint />
      </div>
      {create.isError ? <InlineError>{errorText(create.error)}</InlineError> : null}
    </form>
  );
}
