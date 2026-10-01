import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Provider, ProviderTestResult } from '@gen-harness/contracts';
import { Button } from '@gen-harness/ui';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errorText';
import { qk2 } from '../../lib/dataQueries';
import { queryClient } from '../../lib/queryClient';
import { toast } from '../../lib/toast';
import { currentModelName, isCliKind, modelOptionText, offeredGroups } from './apiModel';

/**
 * v0.1.31 (Boss 01/10: "không thấy model và nhóm model nào để chọn") — ô chọn model THEO NHÓM (Gemini, Claude qua
 * Antigravity, Claude…) kèm gợi ý nhanh/rẻ hay mạnh. "Dùng model này" = model mặc định của nguồn; nguồn CLI được gọi thử
 * thật trước khi lưu (máy chủ trả 422 khi CLI không nhận model → hiện câu lỗi, không lưu). Chọn model riêng cho từng
 * agent vẫn ở màn API & Model › Gán model (các model đã lưu của mọi nguồn).
 */
export function ModelPicker({ provider: p, test }: { provider: Provider; test: ProviderTestResult | null | undefined }) {
  const groups = useMemo(() => offeredGroups(test), [test]);
  const all = useMemo(() => groups.flatMap((g) => g.models), [groups]);
  const current = currentModelName(p);
  const initial = (current && all.some((m) => m.id === current) ? current : null) ?? test?.probe_model ?? all[0]?.id ?? '';
  const [model, setModel] = useState(initial);
  useEffect(() => {
    if (!all.some((m) => m.id === model)) setModel(initial);
  }, [all, model, initial]);
  const add = useMutation({
    mutationFn: () => api.providers.addModel(p.id, { model_name: model, make_default: true }),
    onSuccess: (next) => {
      queryClient.setQueryData<Provider[]>(qk2.providers, (old) => old?.map((x) => (x.id === next.id ? next : x)));
      void queryClient.invalidateQueries({ queryKey: qk2.providers });
      toast(isCliKind(p.kind) ? `Đã gọi thử OK và chọn ${model} cho ${p.name}.` : `Đã chọn ${model} cho ${p.name}.`);
    },
  });
  if (!groups.length) return null;
  const chosen = all.find((m) => m.id === model);
  const fallback = current ?? test?.probe_model ?? all[0]?.id;
  return (
    <div className="prov-model" data-testid={`model-picker-${p.id}`}>
      <select
        className="mini-select"
        aria-label={`Model cho ${p.name}`}
        value={model}
        onChange={(e) => {
          setModel(e.target.value);
          add.reset();
        }}
      >
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.models.map((m) => (
              <option key={m.id} value={m.id} title={m.id}>
                {modelOptionText(m)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <Button variant="secondary" size="sm" loading={add.isPending} disabled={!model || model === current} onClick={() => add.mutate()}>
        {model === current ? 'Đang dùng' : 'Dùng model này'}
      </Button>
      <span className="muted-note">
        {add.isPending && isCliKind(p.kind)
          ? 'Đang gọi thử model này…'
          : current
            ? `Đang dùng ${current}.`
            : `Chưa chọn thì hệ thống dùng ${fallback}.`}
        {chosen && chosen.label !== chosen.id ? ` Mã: ${chosen.id}.` : ''}
        {test?.models_source === 'catalog'
          ? p.kind === 'claude_code_cli'
            ? ' Tên gọi tắt của Claude Code, tự trỏ tới bản mới nhất gói Claude cho dùng.'
            : ' Danh sách gợi ý — model được gọi thử trước khi lưu.'
          : ''}
      </span>
      {add.isError ? <span className="prov-model__err" role="alert">{errorText(add.error)}</span> : null}
    </div>
  );
}
