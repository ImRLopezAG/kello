import type { TableRevisions } from "./revisions";
import type { RevisionWakeups } from "./notifications";
import { publishRuntimeMetric } from "../observability";

export type SubscriptionCloseReason = "UNSUBSCRIBED" | "AUTH_EXPIRED" | "QUERY_ERROR" | "RESYNC_REQUIRED" | "STOPPED";
export interface RevisionEvaluation<T> {
  readonly value: T;
  readonly revisions: TableRevisions;
}
export interface RevisionSubscription<T> {
  readonly evaluate: (signal: AbortSignal) => Promise<RevisionEvaluation<T>>;
  readonly publish: (value: T) => boolean;
  readonly close: (reason: SubscriptionCloseReason, error?: Error) => void;
}
export interface RevisionCoordinatorOptions {
  readonly readRevisions: () => Promise<TableRevisions>;
  readonly intervalMs?: number;
  readonly maxSubscriptions?: number;
  readonly concurrency?: number;
  /** Notify mode only. One shared listener is opened lazily while subscribers exist. */
  readonly wakeups?: (wake: () => void) => RevisionWakeups;
}
interface Subscription {
  readonly session: { readonly expiresAt: number };
  readonly execute: (signal: AbortSignal, polled: TableRevisions) => Promise<TableRevisions>;
  readonly close: RevisionSubscription<never>["close"];
  readonly controller: AbortController;
  expiry?: ReturnType<typeof setTimeout>;
  revisions?: TableRevisions;
  running?: Promise<TableRevisions>;
}

function changed(before: TableRevisions | undefined, after: TableRevisions): boolean {
  return !before || Object.entries(before).some(([table, revision]) => after[table] !== revision);
}
function missing(captured: TableRevisions, polled: TableRevisions): boolean {
  return Object.keys(captured).some((table) => !Object.hasOwn(polled, table));
}
function bounded(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= maximum;
}

/** One instance per active isolate/generation. One all-revision poll serves each subscription's captured keys. */
export function createRevisionCoordinator(options: RevisionCoordinatorOptions) {
  const { readRevisions } = options;
  const interval = options.intervalMs ?? 1000;
  const maximum = options.maxSubscriptions ?? 1000;
  const concurrency = options.concurrency ?? 4;
  if (!bounded(interval, 60_000) || interval < 10 || !bounded(maximum, 1000) || !bounded(concurrency, 20))
    throw new Error("Invalid subscription polling limits");
  const subscriptions = new Set<Subscription>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let dirty = false;
  let wakeups: RevisionWakeups | undefined;
  let retiring: Promise<void> = Promise.resolve();
  let evaluating = 0;
  let queued = 0;
  function report() {
    publishRuntimeMetric({ type: "realtime.coordinator", subscriptions: subscriptions.size, evaluating, queued });
  }

  function stopWakeups() {
    const previous = wakeups;
    wakeups = undefined;
    if (previous) retiring = Promise.all([retiring, previous.stop()]).then(() => {});
  }
  function wake() {
    if (stopped || !subscriptions.size) return;
    const alreadyDirty = dirty;
    dirty = true;
    if (running || alreadyDirty) return;
    cancelTimer();
    schedule(10);
  }

  function cancelTimer() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }
  function close(subscription: Subscription, reason: SubscriptionCloseReason, error?: Error) {
    if (!subscriptions.delete(subscription)) return;
    report();
    if (subscription.expiry) clearTimeout(subscription.expiry);
    subscription.controller.abort();
    if (!subscriptions.size) {
      cancelTimer();
      stopWakeups();
    }
    try {
      subscription.close(reason, error);
    } catch {
      /* A disconnected transport cannot receive another close. */
    }
  }
  function closeAll(reason: SubscriptionCloseReason) {
    // Close callbacks may subscribe again; they must not join this removal pass.
    const previous = [...subscriptions];
    for (const subscription of previous) close(subscription, reason);
  }
  function expire(subscription: Subscription) {
    if (!subscriptions.has(subscription)) return;
    const remaining = subscription.session.expiresAt * 1000 - Date.now();
    if (remaining <= 0) {
      close(subscription, "AUTH_EXPIRED");
      return;
    }
    subscription.expiry = setTimeout(() => expire(subscription), Math.min(remaining, 2_147_483_647));
  }
  function active(subscription: Subscription): boolean {
    if (!subscriptions.has(subscription)) return false;
    if (subscription.session.expiresAt * 1000 <= Date.now()) {
      close(subscription, "AUTH_EXPIRED");
      return false;
    }
    return true;
  }
  async function run() {
    if (stopped || !subscriptions.size) return;
    let revisions: TableRevisions;
    try {
      await retiring;
      if (stopped || !subscriptions.size) return;
      wakeups ??= options.wakeups?.(wake);
      const source = wakeups;
      await source?.ready;
      if (source !== wakeups) {
        dirty = true;
        return;
      }
      if (stopped || !subscriptions.size) return;
      revisions = await readRevisions();
    } catch {
      closeAll("RESYNC_REQUIRED");
      return;
    }
    if (stopped) return;
    const queue = [...subscriptions].filter((subscription) => {
      if (subscription.revisions && missing(subscription.revisions, revisions)) {
        close(subscription, "RESYNC_REQUIRED");
        return false;
      }
      return changed(subscription.revisions, revisions);
    });
    queued = queue.length;
    report();
    let next = 0;
    async function worker() {
      for (;;) {
        const subscription = queue[next++];
        if (!subscription) return;
        queued--;
        report();
        if (!active(subscription)) continue;
        evaluating++;
        report();
        try {
          subscription.running = subscription.execute(subscription.controller.signal, revisions);
          const evaluated = await subscription.running;
          if (active(subscription)) subscription.revisions = Object.freeze({ ...evaluated });
        } catch (error) {
          close(subscription, "QUERY_ERROR", error instanceof Error ? error : new Error("Evaluation failed"));
        } finally {
          evaluating--;
          report();
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  }
  function schedule(delay: number) {
    if (stopped || !subscriptions.size || timer || running) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, delay);
  }
  function poll(): Promise<void> {
    if (running) return running;
    cancelTimer();
    dirty = false;
    // Register the cycle before invoking callbacks, which may reenter the coordinator.
    running = Promise.resolve()
      .then(run)
      .finally(() => {
        running = undefined;
        schedule(dirty ? 10 : interval);
      });
    return running;
  }
  return {
    poll,
    subscribe<T>(verifiedSession: { readonly expiresAt: number }, sink: RevisionSubscription<T>) {
      if (stopped) throw new Error("Subscription poller is stopped");
      if (subscriptions.size >= maximum) throw new Error("Subscription limit reached");
      if (!Number.isSafeInteger(verifiedSession.expiresAt) || verifiedSession.expiresAt <= Date.now() / 1000)
        throw new Error("Subscription session has expired");
      const subscription: Subscription = {
        session: structuredClone(verifiedSession),
        close: sink.close,
        execute: async (signal, polled) => {
          const result = await sink.evaluate(signal);
          if (active(subscription)) {
            if (missing(result.revisions, polled) || !sink.publish(result.value))
              close(subscription, "RESYNC_REQUIRED");
          }
          return result.revisions;
        },
        controller: new AbortController(),
      };
      subscriptions.add(subscription);
      report();
      expire(subscription);
      if (running) dirty = true;
      else {
        cancelTimer();
        schedule(0);
      }
      return {
        unsubscribe: async () => {
          close(subscription, "UNSUBSCRIBED");
          await subscription.running?.catch(() => {});
        },
      };
    },
    async stop() {
      stopped = true;
      cancelTimer();
      closeAll("STOPPED");
      await running;
      await retiring;
    },
  };
}
