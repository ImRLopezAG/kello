// Internal provenance only: unknown external signals remain independently abortable.
const deadlines = new WeakMap<AbortSignal, number>();

export function timedInvocationSignal(durationMs: number): AbortSignal {
  if (!Number.isFinite(durationMs)) throw new RangeError("Invalid invocation duration");
  const started = performance.now();
  // Keep native validation, timer delivery and TimeoutError semantics.
  const signal = AbortSignal.timeout(durationMs);
  constrainInvocationDeadline(signal, started + durationMs);
  return signal;
}

/** Snapshot known minima; later input constraints do not update descendants. */
export function composeInvocationSignals(signals: readonly AbortSignal[]): AbortSignal {
  const signal = AbortSignal.any([...signals]);
  for (const input of signals) {
    const deadline = deadlines.get(input);
    if (deadline !== undefined) constrainInvocationDeadline(signal, deadline);
  }
  return signal;
}

/** Initialize an unknown bound or tighten it, never extend useful-work authority. */
export function constrainInvocationDeadline(signal: AbortSignal, deadline: number): void {
  if (!Number.isFinite(deadline)) throw new RangeError("Invalid invocation deadline");
  const previous = deadlines.get(signal);
  deadlines.set(signal, previous === undefined ? deadline : Math.min(previous, deadline));
}

export function invocationRemainingMs(signal: AbortSignal): number | undefined {
  const deadline = deadlines.get(signal);
  return deadline === undefined ? undefined : deadline - performance.now();
}
