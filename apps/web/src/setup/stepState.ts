import type { SetupState, SetupStep, SetupStepStatus } from '@gen-harness/contracts';
import { SETUP_STEPS, type StepMeta } from './steps';

/** Merge the server's step list with the doc-06 metadata (server wins on title/required). */
export function mergeSteps(state: SetupState | undefined): Array<StepMeta & { status: SetupStepStatus }> {
  return SETUP_STEPS.map((m) => {
    const s: SetupStep | undefined = state?.steps.find((x) => x.n === m.n);
    let status: SetupStepStatus = s?.status ?? 'todo';
    if (status === 'todo' && state?.current_step === m.n) status = 'doing';
    return { ...m, title: s?.title ?? m.title, required: s?.required ?? m.required, status };
  });
}

/** A step can be opened when it is settled or not beyond the server's current step. */
export function isReachable(n: number, state: SetupState | undefined): boolean {
  if (!state) return n === 1;
  const s = state.steps.find((x) => x.n === n);
  return n <= state.current_step || s?.status === 'done' || s?.status === 'skipped';
}
