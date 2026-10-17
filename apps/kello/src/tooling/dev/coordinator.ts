export interface DevelopmentRevision {
  readonly number: number;
  readonly signal: AbortSignal;
  /** Call under the relevant lock immediately before a database or publication side effect. */
  assertCurrent(): void;
}
export interface DevelopmentFailure {
  readonly revision: number;
  readonly error: Error;
}
export interface DevelopmentCoordinatorOptions {
  readonly debounceMs?: number;
}

/** Owns one update pipeline at a time, including cleanup after cancellation. */
export function createDevelopmentCoordinator(
  update: (revision: DevelopmentRevision) => Promise<void>,
  options: DevelopmentCoordinatorOptions = {},
) {
  const debounceMs = options.debounceMs ?? 75;
  if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > 60_000)
    throw new Error("Development debounce must be between 0 and 60000 milliseconds");
  let number = 0;
  let stopped = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let failure: DevelopmentFailure | null = null;
  // First non-cancellation failure from a stopped or superseded revision; stop() reports it.
  let drained: Error | undefined;
  const stale = new WeakSet<object>();
  const waiters = new Set<() => void>();

  function notifyIdle() {
    if (running || timer || pending) return;
    for (const resolve of waiters) resolve();
    waiters.clear();
  }
  async function run() {
    while (pending && !stopped) {
      pending = false;
      const revisionNumber = number;
      const cancellation = new AbortController();
      controller = cancellation;
      const revision: DevelopmentRevision = {
        number: revisionNumber,
        signal: cancellation.signal,
        assertCurrent() {
          if (stopped || revisionNumber !== number || cancellation.signal.aborted) {
            const error = new Error("Development revision is no longer current");
            stale.add(error);
            throw error;
          }
        },
      };
      try {
        await update(revision);
        if (revisionNumber === number && !stopped) failure = null;
      } catch (cause) {
        const { reason } = cancellation.signal;
        // Cancellation surfaces as the abort reason, a timer AbortError wrapping it, or assertCurrent's error.
        const cancelled =
          cancellation.signal.aborted &&
          (cause === reason ||
            (cause instanceof Error && cause.name === "AbortError" && cause.cause === reason) ||
            (cause instanceof Error && stale.has(cause)));
        if (revisionNumber === number && !stopped && !cancellation.signal.aborted)
          failure = { revision: revisionNumber, error: new Error("Development update failed", { cause }) };
        else if (!cancelled) drained ??= new Error("Development update cleanup failed", { cause });
      } finally {
        controller = undefined;
      }
    }
  }
  function begin() {
    if (running || stopped || !pending) return;
    running = run().finally(() => {
      running = undefined;
      begin();
      notifyIdle();
    });
  }
  function cancelTimer() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }
  function ready() {
    cancelTimer();
    pending = true;
    begin();
  }
  function settled(): Promise<void> {
    if (!running && !timer && !pending) return Promise.resolve();
    return new Promise((resolve) => waiters.add(resolve));
  }
  return {
    get failure(): DevelopmentFailure | null {
      return failure;
    },
    invalidate(): void {
      if (stopped) throw new Error("Development coordinator is stopped");
      number++;
      controller?.abort();
      pending = false;
      cancelTimer();
      timer = setTimeout(ready, debounceMs);
    },
    async flush(this: void): Promise<void> {
      if (timer) ready();
      await settled();
    },
    settled,
    async stop(): Promise<void> {
      stopped = true;
      pending = false;
      cancelTimer();
      controller?.abort();
      notifyIdle();
      await settled();
      if (drained) throw drained;
    },
  };
}
