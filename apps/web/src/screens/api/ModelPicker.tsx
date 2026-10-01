import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Effort, ModelGroup, Provider, ProviderTestResult } from '@gen-harness/contracts';
import { Button } from '@gen-harness/ui';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errorText';
import { qk2 } from '../../lib/dataQueries';
import { queryClient } from '../../lib/queryClient';
import { toast } from '../../lib/toast';
import { EFFORT_HINT, choiceText, effortOptionText, currentChoice, isCliKind, modelOptionText, offeredGroups, pickEffort, technicalDetail } from './apiModel';

/**
 * v0.1.31 (Boss 01/10: "không thấy model và nhóm model nào để chọn") — ô chọn model THEO NHÓM (Gemini, Claude qua
 * Antigravity, Claude…) kèm gợi ý nhanh/rẻ hay mạnh. "Dùng model này" = model mặc định của nguồn; nguồn CLI được gọi thử
 * thật trước khi lưu (máy chủ trả 422 khi CLI không nhận → hiện câu lỗi + "Chi tiết kỹ thuật", không lưu).
 *
 * v0.1.32 (Boss 01/10: "high" là mức suy nghĩ, không phải tên model) — ô model chỉ có TÊN MODEL GỐC; "Mức suy nghĩ"
 * (Thấp / Vừa / Cao…) là ô riêng, chỉ hiện các mức model đó nhận. Danh sách không bao giờ thu gọn còn model đã lưu.
 */
export function ModelPicker({ provider: p, test }: { provider: Provider; test: ProviderTestResult | null | undefined }) {
  const current = currentChoice(p);
  const groups = useMemo(() => withSaved(offeredGroups(test), current?.model ?? null), [test, current?.model]);
  const all = useMemo(() => groups.flatMap((g) => g.models), [groups]);
  const initial = (current && all.some((m) => m.id === current.model) ? current.model : null) ?? test?.probe_model ?? all[0]?.id ?? '';
  const [model, setModel] = useState(initial);
  const chosen = all.find((m) => m.id === model);
  const [effort, setEffort] = useState<Effort | null>(() => pickEffort(chosen, model === current?.model ? current?.effort : test?.probe_effort));
  useEffect(() => {
    if (!all.some((m) => m.id === model)) setModel(initial);
  }, [all, model, initial]);
  useEffect(() => {
    // Model mới không nhận mức đang chọn → về mức hợp lệ của model đó.
    const effs = chosen?.efforts ?? [];
    if (effort && !effs.includes(effort)) setEffort(pickEffort(chosen, null));
    else if (!effort && effs.length) setEffort(pickEffort(chosen, model === current?.model ? current?.effort : null));
  }, [chosen, effort, model, current?.model, current?.effort]);
  const add = useMutation({
    mutationFn: () => api.providers.addModel(p.id, { model_name: model, make_default: true, effort }),
    onSuccess: (next) => {
      queryClient.setQueryData<Provider[]>(qk2.providers, (old) => old?.map((x) => (x.id === next.id ? next : x)));
      void queryClient.invalidateQueries({ queryKey: qk2.providers });
      const what = choiceText(model, effort);
      toast(isCliKind(p.kind) ? `Đã gọi thử OK và chọn ${what} cho ${p.name}.` : `Đã chọn ${what} cho ${p.name}.`);
    },
  });
  if (!groups.length) return null;
  const isCurrent = !!current && model === current.model && (effort ?? null) === (current.effort ?? null);
  const fallback = current ? choiceText(current.model, current.effort) : (test?.probe_model ?? all[0]?.id);
  const efforts = chosen?.efforts ?? [];
  const tech = add.isError ? technicalDetail(add.error) : null;
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
              <option key={m.id} value={m.id} title={m.source_ref ? `${m.id} — nguồn: ${m.source_ref}` : m.id}>
                {modelOptionText(m)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {efforts.length ? (
        <label className="prov-model__effort">
          <span className="muted-note">Mức suy nghĩ</span>
        <select
          className="mini-select"
          aria-label={`Mức suy nghĩ (effort) cho ${p.name}`}
          title={EFFORT_HINT}
          value={effort ?? ''}
          onChange={(e) => {
            setEffort((e.target.value || null) as Effort | null);
            add.reset();
          }}
        >
          {efforts.map((x) => (
            <option key={x} value={x}>
              {effortOptionText(x)}
            </option>
          ))}
        </select>
        </label>
      ) : null}
      <Button variant="secondary" size="sm" loading={add.isPending} disabled={!model || isCurrent} onClick={() => add.mutate()}>
        {isCurrent ? 'Đang dùng' : 'Dùng model này'}
      </Button>
      <span className="muted-note">
        {add.isPending && isCliKind(p.kind)
          ? 'Đang gọi thử model này…'
          : current
            ? `Đang dùng ${choiceText(current.model, current.effort)}.`
            : `Chưa chọn thì hệ thống dùng ${fallback}.`}
        {chosen && chosen.label !== chosen.id ? ` Mã: ${chosen.id}.` : ''}
        {efforts.length ? ` Mức suy nghĩ: ${EFFORT_HINT}.` : isCliKind(p.kind) && chosen ? ' Model này không chỉnh mức suy nghĩ — CLI tự chọn.' : ''}
        {chosen?.verified === false
          ? ' Chưa xác minh bằng CLI — sẽ gọi thử thật trước khi lưu.'
          : test?.models_source === 'catalog' && p.kind === 'claude_code_cli'
            ? ' Tên gọi tắt của Claude Code, tự trỏ tới bản mới nhất gói Claude cho dùng.'
            : ''}
      </span>
      {add.isError ? (
        <div className="prov-model__err" role="alert">
          {errorText(add.error)}
          {tech ? (
            <details className="tech-detail">
              <summary>Chi tiết kỹ thuật</summary>
              <code>{tech}</code>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Model đã lưu mà danh sách không có (vd máy chủ cũ) vẫn hiện — không bao giờ mất lựa chọn đang dùng. */
function withSaved(groups: ModelGroup[], saved: string | null): ModelGroup[] {
  if (!saved || !groups.length || groups.some((g) => g.models.some((m) => m.id === saved))) return groups;
  return [...groups, { label: 'Đã lưu', models: [{ id: saved, label: saved, group: 'Đã lưu', tier: 'balanced', hint: '', source: 'saved' }] }];
}
