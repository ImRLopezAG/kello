import * as v from "valibot";

export interface IdleBackoffOptions {
  /** First skip window after an empty pass. Defaults to one minute. */
  readonly initialMs?: number;
  /** Ceiling; keep it above the database's idle-suspend window (Neon: 5 minutes). Defaults to ten minutes. */
  readonly maxMs?: number;
  readonly now?: () => number;
}

export interface IdleBackoff {
  /** False while an idle isolate should skip provider wake-ups without touching the database. */
  shouldPoll(): boolean;
  /** Records a completed pass. Any claimed job clears the backoff. */
  record(claimed: number): void;
  /** Known new work (cron enqueue, storage event) polls on the next wake. */
  reset(): void;
  /** Milliseconds until the next allowed poll; zero when polling is allowed. */
  remainingMs(): number;
}

const duration = v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(24 * 60 * 60 * 1000));

/** Per-isolate state only: a cold isolate polls once, then resumes backing off. Leases are unaffected
 * because backoff applies only after a pass that claimed nothing. */
export function createIdleBackoff(options: IdleBackoffOptions = {}): IdleBackoff {
  const initial = v.parse(duration, options.initialMs ?? 60_000);
  const max = v.parse(duration, options.maxMs ?? 600_000);
  if (max < initial) throw new Error("Idle backoff maximum must not be below its initial delay");
  const now = options.now ?? Date.now;
  let emptyPasses = 0;
  let nextPollAt = 0;
  return Object.freeze({
    shouldPoll: () => now() >= nextPollAt,
    remainingMs: () => Math.max(0, nextPollAt - now()),
    record(claimed: number) {
      if (claimed > 0) {
        emptyPasses = 0;
        nextPollAt = 0;
        return;
      }
      emptyPasses = Math.min(emptyPasses + 1, 32);
      nextPollAt = now() + Math.min(max, initial * 2 ** (emptyPasses - 1));
    },
    reset() {
      emptyPasses = 0;
      nextPollAt = 0;
    },
  });
}
