/** Pure logic for setup steps 4–7 and 12 (unit-tested). */
import type { ChannelGroup, CliKind, FirstRun, ListenMode, Provider, ProviderTestResult, RefineryProgress, SetupState, ViewScope } from '@gen-harness/contracts';

/**
 * Bước 4: a provider can go into the chain when it tested OK here, is already healthy, or is a CLI with an active
 * profile. `cliActive`: one flag (Antigravity, older callers) or one per CLI kind (v0.1.31: + Claude Code).
 */
export function providerReady(
  p: Provider,
  tested: Record<string, ProviderTestResult>,
  cliActive: boolean | Partial<Record<CliKind, boolean>>,
): boolean {
  if (tested[p.id]) return tested[p.id].ok;
  if (p.kind === 'antigravity_cli' || p.kind === 'claude_code_cli')
    return typeof cliActive === 'boolean' ? (p.kind === 'antigravity_cli' ? cliActive : false) : !!cliActive[p.kind];
  return p.auth_state === 'ok';
}

export type GroupDraft = Record<string, { listen_mode: ListenMode; view_scope: ViewScope }>;

/** Bước 6: apply local edits over the server rows. */
export function applyGroupDraft(groups: ChannelGroup[], draft: GroupDraft): ChannelGroup[] {
  return groups.map((g) => (draft[g.id] ? { ...g, ...draft[g.id] } : g));
}

/** Bước 6 completes when at least one group listens (≠ off). */
export const anyListening = (groups: Array<Pick<ChannelGroup, 'listen_mode'>>) => groups.some((g) => g.listen_mode !== 'off');

// ── Bước 7 ────────────────────────────────────────────────────────────────
export const INTERVAL_OPTIONS = [5, 15, 30, 60];
export const THRESHOLD_OPTIONS = [100, 250, 500, 1000];
export const CONFIDENCE_OPTIONS = [0.5, 0.6, 0.7, 0.8];

/** Snap a server value to the nearest offered option. */
export function nearest(options: number[], v: number | undefined, fallback: number): number {
  if (v === undefined || Number.isNaN(v)) return fallback;
  return options.reduce((best, o) => (Math.abs(o - v) < Math.abs(best - v) ? o : best), options[0]);
}

/**
 * v0.1.55 (Thiết lập gọn) — câu hỏi duy nhất của bước 7: "Sếp làm ngành nào?". Mỗi lựa chọn là một bộ quy tắc khởi đầu (mã
 * quy tắc R-01…R-06 của gh/refinery/presets.py); lịch sàng lọc 900 giây / 500 tin / lô 250 / tin cậy 0,6 là mặc định của
 * máy chủ. "Khác" bật cả bộ khởi đầu (cũng là cách máy chủ làm khi không gửi `rule_codes`).
 */
export interface IndustryOption {
  value: 'trade' | 'service' | 'hr' | 'other';
  label: string;
  codes: readonly string[];
}
export const INDUSTRIES: readonly IndustryOption[] = [
  { value: 'trade', label: 'Mua bán, thương mại', codes: ['R-01', 'R-02', 'R-03', 'R-04', 'R-06'] },
  { value: 'service', label: 'Dịch vụ, chăm sóc khách', codes: ['R-01', 'R-03', 'R-04', 'R-06'] },
  { value: 'hr', label: 'Tuyển dụng, nhân sự', codes: ['R-03', 'R-05', 'R-06'] },
  { value: 'other', label: 'Khác — bật cả bộ khởi đầu', codes: ['R-01', 'R-02', 'R-03', 'R-04', 'R-05', 'R-06'] },
];
/** Ngành đang chọn mặc định (cả bộ khởi đầu). */
export const DEFAULT_INDUSTRY: IndustryOption['value'] = 'other';

/** Mã quy tắc của một ngành, chỉ giữ mã máy chủ đang có (`available`). Ngành lạ ⇒ rỗng. */
export function industryCodes(value: string, available: readonly string[]): string[] {
  const it = INDUSTRIES.find((x) => x.value === value);
  return it ? available.filter((c) => it.codes.includes(c)) : [];
}

/** Ngành khớp ĐÚNG bộ quy tắc đang chọn (không phân biệt thứ tự); không khớp ⇒ null (Sếp đã chỉnh tay ở Nâng cao). */
export function industryOf(picked: readonly string[], available: readonly string[]): IndustryOption['value'] | null {
  const key = [...picked].sort().join(',');
  const hit = INDUSTRIES.find((it) => industryCodes(it.value, available).slice().sort().join(',') === key);
  return hit?.value ?? null;
}

// ── Bước 12 ───────────────────────────────────────────────────────────────
/**
 * First-run counters: `GET /setup/first-run`, advanced live by the latest
 * `refinery.progress` of the same run (the progress frame is newer).
 */
export function firstRunCounters(f: FirstRun | undefined, p: RefineryProgress | null | undefined) {
  const base = {
    raw: f?.raw_collected ?? 0,
    classifying: f?.classifying ?? 0,
    clean: f?.clean ?? 0,
    lowconf: f?.lowconf ?? 0,
    discarded: f?.discarded ?? 0,
  };
  const live = p && (!f?.run || p.run_id === f.run.id) ? p : null;
  if (live) {
    base.clean = Math.max(base.clean, live.clean);
    base.lowconf = Math.max(base.lowconf, live.lowconf);
    base.discarded = Math.max(base.discarded, live.noise);
    base.classifying = live.status === 'done' || live.status === 'failed' ? 0 : Math.max(0, live.total - live.processed);
  }
  const status: 'idle' | 'running' | 'done' | 'failed' = live
    ? live.status === 'queued'
      ? 'running'
      : live.status
    : f?.run
      ? f.run.status === 'queued'
        ? 'running'
        : f.run.status
      : 'idle';
  const pct = live && live.total > 0 ? Math.round((live.processed / live.total) * 100) : status === 'done' ? 100 : 0;
  return { ...base, status, pct };
}

/**
 * Required steps (other than 12) not yet done — `PUT /setup/steps/12` answers
 * 409 STEP_INCOMPLETE while any remain (phase 2: 8 and 9 are not built yet).
 */
export function missingRequiredSteps(state: SetupState | undefined): Array<{ n: number; title: string }> {
  return (state?.steps ?? []).filter((s) => s.required && s.n !== 12 && s.status !== 'done').map((s) => ({ n: s.n, title: s.title }));
}

// ── Bước 4 (v0.1.28, UX C1) ───────────────────────────────────────────────
/** Model names a provider offered when last tested — this session's result first, else the one saved on the server. */
export function testedModels(p: Provider, tested: Record<string, ProviderTestResult>): string[] {
  const t = tested[p.id] ?? p.last_test ?? null;
  return t?.ok ? (t.models ?? []).filter((m) => !/embed/i.test(m)) : [];
}

/**
 * A ready provider can actually answer: it already has a model, or it tested OK and offered one (the server picks
 * the first when the Owner did not press "Dùng model này"). "Tiếp tục" stays off until one ready provider can.
 */
export function providerHasModel(p: Provider, tested: Record<string, ProviderTestResult>): boolean {
  return p.models.length > 0 || testedModels(p, tested).length > 0;
}

// ── Bước 12 (v0.1.28, UX C1/V10) ──────────────────────────────────────────
export interface SetupGap {
  key: 'model' | 'channel' | 'groups' | 'rules' | 'backup';
  text: string;
  step: number;
}

/** What still keeps the system from running on its own — Bước 12 lists these instead of "Mọi thứ đã sẵn sàng". */
export function setupGaps(i: {
  providers?: Provider[];
  activeChannels?: number;
  groupsListening?: number;
  enabledRules?: number;
  backupDone?: boolean;
}): SetupGap[] {
  const out: SetupGap[] = [];
  if (i.providers && !i.providers.some((p) => p.enabled && p.kind !== 'system_one' && p.models.length > 0))
    out.push({ key: 'model', text: 'Chưa có model AI nào để trợ lý trả lời và sàng lọc tin', step: 4 });
  if (i.activeChannels === 0) out.push({ key: 'channel', text: 'Chưa kết nối kênh chat nào (Zalo, WhatsApp…)', step: 5 });
  if (i.groupsListening === 0) out.push({ key: 'groups', text: 'Chưa bật nhóm nào để lắng nghe', step: 6 });
  if (i.enabledRules === 0) out.push({ key: 'rules', text: 'Chưa có quy tắc sàng lọc nào', step: 7 });
  if (i.backupDone === false) out.push({ key: 'backup', text: 'Chưa có lịch sao lưu tự động', step: 11 });
  return out;
}
