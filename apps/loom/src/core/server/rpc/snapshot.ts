import { AsyncLocalStorage } from "node:async_hooks";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { RevisionReader, TableRevisions } from "../realtime/revisions";
import type { DependencyRegistry } from "../realtime/dependencies";

interface Capture {
  active: boolean;
  attempt?: Attempt;
  revisions?: TableRevisions;
}
const captures = new AsyncLocalStorage<Capture>();
interface Attempt {
  readonly capture: Capture;
  readonly registry: DependencyRegistry | undefined;
  readonly keys: Set<string>;
  readonly readers: Set<RevisionReader>;
  readonly segments: { complete: boolean }[];
  unknown: boolean;
  active: boolean;
  completed: boolean;
  revisions?: TableRevisions;
}
const attempts = new AsyncLocalStorage<Attempt>();
// Ownership stays private: application values and future optional evidence keep their shape.
const candidates = new WeakMap<object, Attempt>();

function assertAttemptCurrent(attempt: Attempt): void {
  if (!attempt.active || !attempt.capture.active || attempts.getStore() !== attempt)
    throw new Error("Snapshot attempt is inactive");
  if (captures.getStore() !== attempt.capture) throw new Error("Snapshot belongs to a different evaluation");
}

/** A fresh collector per transaction attempt. Its candidate is not visible until commit succeeds. */
export async function runSnapshotAttempt<T>(
  db: NodePgDatabase,
  registry: DependencyRegistry | undefined,
  selective: boolean,
  work: () => Promise<T>,
): Promise<{ value: T; revisions?: TableRevisions }> {
  const capture = captures.getStore();
  if (!capture) return { value: await work() };
  if (!capture.active) throw new Error("Snapshot evaluation is inactive");
  if (capture.revisions) throw new Error("Live evaluation requires one owning transaction");
  if (attempts.getStore() || (capture.attempt && !capture.attempt.completed))
    throw new Error("Live evaluation cannot own a second transaction");
  const attempt: Attempt = {
    capture,
    registry,
    keys: new Set(),
    readers: new Set(),
    segments: [],
    unknown: false,
    active: true,
    completed: false,
  };
  // A retry supersedes any candidate from the transaction that was rejected.
  capture.attempt = attempt;
  return attempts.run(attempt, async () => {
    try {
      const value = await work();
      assertAttemptCurrent(attempt);
      // Owned work has drained. Late callbacks cannot change the finalized selection.
      attempt.active = false;
      let revisions: TableRevisions;
      if (registry) {
        const complete =
          selective &&
          !attempt.unknown &&
          attempt.segments.length > 0 &&
          attempt.segments.every((segment) => segment.complete);
        if (complete && !attempt.keys.size) throw new Error("Selective snapshot requires a table dependency");
        revisions = await registry.read(db, complete ? attempt.keys : registry.keys);
      } else {
        if (!attempt.readers.size) throw new Error("Live evaluation requires a revision reader");
        const merged: Record<string, string> = {};
        for (const read of attempt.readers) {
          for (const [key, revision] of Object.entries(await read(db))) {
            if (Object.hasOwn(merged, key) && merged[key] !== revision)
              throw new Error("Conflicting snapshot revisions");
            merged[key] = revision;
          }
        }
        revisions = Object.freeze(merged);
      }
      if (!capture.active) throw new Error("Snapshot evaluation is inactive");
      const candidate = { value, revisions };
      attempt.revisions = revisions;
      candidates.set(candidate, attempt);
      return candidate;
    } finally {
      attempt.active = false;
      attempt.completed = true;
    }
  });
}

export function acceptSnapshotAttempt(candidate: { readonly revisions?: TableRevisions }): void {
  const capture = captures.getStore();
  const owner = candidates.get(candidate);
  if (!capture && !owner) return;
  if (!capture?.active) throw new Error("Snapshot evaluation is inactive");
  if (!owner || owner.capture !== capture || capture.attempt !== owner)
    throw new Error("Snapshot candidate belongs to a different evaluation or owning attempt");
  if (!owner.completed || attempts.getStore()) throw new Error("Snapshot owning attempt has not completed");
  if (capture.revisions) throw new Error("Live evaluation requires one owning transaction");
  if (!candidate.revisions || candidate.revisions !== owner.revisions)
    throw new Error("Live evaluation requires the owning attempt's snapshot revisions");
  capture.revisions = candidate.revisions;
}

/** Non-database nested handlers have no compiler completeness evidence. */
export function markSnapshotUnknown(): void {
  const attempt = attempts.getStore();
  if (attempt) {
    assertAttemptCurrent(attempt);
    attempt.unknown = true;
  }
}

/** Register before authorization. The returned callback belongs only to this attempt. */
export function registerSnapshotSegment(options: {
  readonly registry?: DependencyRegistry | undefined;
  readonly keys?: readonly string[] | undefined;
  readonly reader?: RevisionReader | undefined;
}) {
  const attempt = attempts.getStore();
  if (!attempt) return (_keys: readonly string[], _complete: boolean) => {};
  assertAttemptCurrent(attempt);
  if (attempt.registry !== options.registry) throw new Error("Snapshot belongs to a different generation");
  if (options.reader) attempt.readers.add(options.reader);
  if (!options.keys) attempt.unknown = true;
  for (const key of options.keys ?? []) attempt.keys.add(key);
  const segment = { complete: false };
  attempt.segments.push(segment);
  return (keys: readonly string[], complete: boolean) => {
    assertAttemptCurrent(attempt);
    for (const key of keys) attempt.keys.add(key);
    if (!complete) attempt.unknown = true;
    segment.complete = true;
  };
}

export async function evaluateSnapshot<T>(evaluate: () => Promise<T>) {
  const capture: Capture = { active: true };
  try {
    const value = await captures.run(capture, evaluate);
    if (!capture.revisions) throw new Error("Live evaluation requires a database-read transaction");
    return { value, revisions: capture.revisions };
  } finally {
    capture.active = false;
  }
}
