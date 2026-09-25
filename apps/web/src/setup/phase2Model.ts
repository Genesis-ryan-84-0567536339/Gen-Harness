/** Pure logic for setup steps 4–7 and 12 (unit-tested). */
import type { ChannelGroup, FirstRun, ListenMode, Provider, ProviderTestResult, RefineryProgress, SetupState, ViewScope } from '@gen-harness/contracts';

/** Bước 4: a provider can go into the chain when it tested OK here, is already healthy, or is the CLI with an active profile. */
export function providerReady(p: Provider, tested: Record<string, ProviderTestResult>, cliActive: boolean): boolean {
  if (tested[p.id]) return tested[p.id].ok;
  if (p.kind === 'antigravity_cli') return cliActive;
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
