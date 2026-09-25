import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Weight } from '@gen-harness/contracts';
import { EmptyState, Segmented, Tag, type Tone } from '@gen-harness/ui';
import { api } from '../lib/api';
import { qk2, useSchedule, useWeights } from '../lib/dataQueries';
import { fmtDec, fmtInt } from '../lib/format';
import { CardError, SkeletonLines } from '../screens/common';
import { BAD, OK, conditionLabel, outputLabel, weightsMessage, weightsValid } from '../screens/data/dataModel';
import { WeightSliders } from '../screens/data/WeightSliders';
import { CONFIDENCE_OPTIONS, INTERVAL_OPTIONS, THRESHOLD_OPTIONS, nearest } from './phase2Model';
import { StepFrame } from './StepFrame';
import { describeError, type StepProps } from './types';

const kindTone = (k: string): Tone => (k === 'risk' ? 'bad' : k === 'competition' || k === 'hr' ? 'warn' : 'neutral');

/** Bước 7 — schedule, starter rules R-01…R-06, scoring weights (sum 100%). */
export function Step7Refinery({ meta, description, onBack, onSaved, formRef }: StepProps) {
  const schedule = useSchedule();
  const presets = useQuery({ queryKey: qk2.rulePresets, queryFn: ({ signal }) => api.setup.rulePresets(signal) });
  const weightsQ = useWeights();

  const [intervalMin, setIntervalMin] = useState(15);
  const [threshold, setThreshold] = useState(500);
  const [confidence, setConfidence] = useState(0.6);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [weights, setWeights] = useState<Weight[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!schedule.data) return;
    setIntervalMin(nearest(INTERVAL_OPTIONS, schedule.data.interval_seconds / 60, 15));
    setThreshold(nearest(THRESHOLD_OPTIONS, schedule.data.count_threshold, 500));
    setConfidence(nearest(CONFIDENCE_OPTIONS, schedule.data.min_confidence, 0.6));
  }, [schedule.data]);
  useEffect(() => {
    if (presets.data && picked === null) setPicked(presets.data.filter((r) => r.enabled).map((r) => r.code));
  }, [presets.data, picked]);
  useEffect(() => {
    if (weightsQ.data && weights === null) setWeights(weightsQ.data);
  }, [weightsQ.data, weights]);

  const ws = weights ?? [];
  const wMsg = weights ? weightsMessage(ws) : null;
  const canContinue = !!weights && weightsValid(ws) && (picked?.length ?? 0) > 0;

  const save = async () => {
    setBusy(true);
    setFormError(null);
    try {
      onSaved(
        await api.setup.step7({
          interval_seconds: intervalMin * 60,
          count_threshold: threshold,
          min_confidence: confidence,
          rule_codes: picked ?? [],
          weights: ws.map((w) => ({ dimension: w.dimension, value: w.value })),
        }),
      );
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
      formError={formError}
    >
      <div className="setup-section">
        <div className="setup-section__title">Kích hoạt sàng lọc · cái nào đến trước</div>
        <div className="setup-grid">
          <div className="seg-field">
            <span className="seg-field__label">Chu kỳ thời gian</span>
            <Segmented
              label="Chu kỳ thời gian"
              value={String(intervalMin)}
              onChange={(v) => setIntervalMin(Number(v))}
              options={INTERVAL_OPTIONS.map((m) => ({ value: String(m), label: `${m} phút` }))}
            />
          </div>
          <div className="seg-field">
            <span className="seg-field__label">Ngưỡng số lượng</span>
            <Segmented
              label="Ngưỡng số lượng"
              value={String(threshold)}
              onChange={(v) => setThreshold(Number(v))}
              options={THRESHOLD_OPTIONS.map((n) => ({ value: String(n), label: fmtInt(n) }))}
            />
          </div>
        </div>
        <div className="seg-field">
          <span className="seg-field__label">Ngưỡng tin cậy vào kho sạch</span>
          <Segmented
            label="Ngưỡng tin cậy vào kho sạch"
            value={String(confidence)}
            onChange={(v) => setConfidence(Number(v))}
            options={CONFIDENCE_OPTIONS.map((c) => ({ value: String(c), label: `≥ ${fmtDec(c, 2)}` }))}
          />
        </div>
        {schedule.isError ? <p className="muted-note">Không đọc được lịch hiện tại — dùng giá trị mặc định.</p> : null}
      </div>

      <div className="setup-section">
        <div className="setup-section__title">Bộ quy tắc khởi đầu</div>
        {presets.isPending ? (
          <SkeletonLines rows={4} padding="0" />
        ) : presets.isError ? (
          <CardError error={presets.error} onRetry={() => void presets.refetch()} retrying={presets.isFetching} />
        ) : presets.data.length === 0 ? (
          <EmptyState icon="ph ph-funnel" title="Không có bộ quy tắc mẫu" />
        ) : (
          <div className="preset-list">
            {presets.data.map((r) => {
              const on = picked?.includes(r.code) ?? false;
              return (
                <label className="preset" key={r.code} data-checked={on || undefined}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) =>
                      setPicked((p) => (e.target.checked ? [...(p ?? []), r.code] : (p ?? []).filter((c) => c !== r.code)))
                    }
                  />
                  <span className="preset__body">
                    <span className="preset__head">
                      <span className="rule-card__code">{r.code}</span>
                      <span className="rule-card__name">{r.name}</span>
                      <Tag tone={kindTone(r.kind)}>{r.kind_label}</Tag>
                    </span>
                    <span className="rule-chips">
                      {r.conditions.map((c, i) => (
                        <span className="cond-chip" key={`c${i}`}>
                          {conditionLabel(c)}
                        </span>
                      ))}
                      {r.outputs.map((o, i) => (
                        <span className="out-chip" key={`o${i}`}>
                          {outputLabel(o)}
                        </span>
                      ))}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {picked && picked.length === 0 ? <p className="inline-error">Chọn ít nhất một quy tắc.</p> : null}
      </div>

      <div className="setup-section">
        <div className="setup-section__title">Trọng số chấm điểm · tổng 100%</div>
        {weightsQ.isPending ? (
          <SkeletonLines rows={6} padding="0" />
        ) : weightsQ.isError ? (
          <CardError error={weightsQ.error} onRetry={() => void weightsQ.refetch()} retrying={weightsQ.isFetching} />
        ) : (
          <div className="weights" style={{ padding: 0 }}>
            <WeightSliders
              weights={ws}
              idPrefix="setup-w"
              onChange={(i, v) => setWeights((cur) => (cur ?? []).map((w, j) => (j === i ? { ...w, value: v } : w)))}
            />
            <span className="weights__sum" role="status" style={{ color: wMsg ? BAD : OK }}>
              {wMsg ?? 'Tổng 100%.'}
            </span>
          </div>
        )}
      </div>
    </StepFrame>
  );
}
