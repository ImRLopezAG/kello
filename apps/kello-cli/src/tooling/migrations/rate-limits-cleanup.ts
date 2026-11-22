import { closeSession, createDatabaseSession, createSessionPool, quoteIdentifier } from "./connection";
import type { DatabaseSession } from "./connection";
import type { SessionResult, SessionRow } from "./connection";
import type { Pool } from "drizzle-orm/postgres/client/node";
import { frameworkMigrations } from "./bootstrap";
import { classifyFrameworkHistory } from "./framework-history";

export interface CleanupRateLimitsOptions {
  readonly connectionString: string;
  readonly metadataNamespace: string;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly maxDurationMs?: number;
  readonly signal?: AbortSignal;
}

export interface RateLimitCleanupResult {
  readonly removed: number;
  readonly batches: number;
  readonly hasMore: boolean;
  readonly oldestExpiredAgeMs: number | null;
  readonly stoppedBy: "empty" | "batch-budget" | "time-budget";
}

// Never attach SQL/provider causes to the public Error. Keep the first operation
// failure and each cleanup failure separately, for the lifetime of that Error.
interface CleanupFailureDetails {
  primary: { error: unknown } | undefined;
  cleanup: readonly { phase: "cancel" | "destroy" | "connect-drain" | "query-drain" | "close"; error: unknown }[];
}
const failureDetails = new WeakMap<Error, CleanupFailureDetails>();

function cleanupFailed(details: CleanupFailureDetails, removed = 0, batches = 0): Error {
  const error = Object.assign(new Error("Rate limit cleanup failed"), { removed, batches });
  failureDetails.set(error, details);
  return error;
}

function budget(value: number | undefined, maximum: number): number {
  const result = value ?? maximum;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new Error("Invalid rate limit cleanup input");
  return result;
}

/** Owner-only retention maintenance. Each confirmed batch is durable independently. */
export async function cleanupRateLimits(options: CleanupRateLimitsOptions): Promise<RateLimitCleanupResult> {
  const started = performance.now();
  let schema: string;
  let url: URL;
  try {
    schema = quoteIdentifier(options.metadataNamespace);
    url = new URL(options.connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error("Invalid rate limit cleanup input");
  }
  const batchSize = budget(options.batchSize, 500);
  const maxBatches = budget(options.maxBatches, 20);
  const maxDurationMs = budget(options.maxDurationMs, 30_000);
  const deadline = started + maxDurationMs;
  // Reserve transport cancellation and local close time inside the same run
  // budget. Short runs split their budget rather than adding a 2s cancel tail.
  const closeReserveMs = Math.min(50, maxDurationMs / 10);
  const workDeadline = deadline - Math.min(2000, maxDurationMs / 2) - closeReserveMs;
  const remaining = () => Math.max(1, Math.ceil(workDeadline - performance.now()));
  let pool: Pool;
  try {
    const timeout = remaining();
    pool = createSessionPool(url.href, {
      applicationName: "kello-rate-limits-cleanup",
      connectTimeout: timeout,
      options: `-c search_path=pg_catalog -c statement_timeout=${timeout} -c lock_timeout=${timeout}`,
    });
  } catch (error) {
    throw cleanupFailed({ primary: { error }, cleanup: [] });
  }
  // Aborting sends the transport's CancelRequest for the statement in flight.
  const cancellation = new AbortController();
  let client: DatabaseSession | undefined;
  let activeQuery: Promise<unknown> | undefined;
  let connected = false;
  let connectionAttempt: ReturnType<Pool["connect"]> | undefined;
  let stopped = false;
  let shutdownPromise: Promise<void> | undefined;
  let removed = 0;
  let batches = 0;
  let primaryFailure: { error: unknown } | undefined;
  const cleanupFailures: { phase: "cancel" | "destroy" | "connect-drain" | "query-drain" | "close"; error: unknown }[] =
    [];
  // One owner of shutdown, including when the run fails while cancellation is
  // still in flight. The session stays open until its cancel settles.
  function shutdown(): Promise<void> {
    // Install the shared promise before any driver callback can reenter stop.
    return (shutdownPromise ??= Promise.resolve().then(async () => {
      // Bun can defer promise reactions queued from socket close callbacks until
      // an unrelated event wakes the loop; at worst that is the watchdog at the
      // deadline. Keep the loop turning while shutdown owns the sockets.
      const wake = setInterval(() => {}, 5);
      try {
        const draining = activeQuery;
        if (draining) {
          try {
            // Never pass zero/negative or extend the absolute run budget. Required
            // close/drain still runs if no cancellation budget remains.
            const cancellationBudget = deadline - performance.now() - closeReserveMs;
            if (cancellationBudget <= 0) throw new Error("Rate limit cleanup failed");
            cancellation.abort();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const settled = await Promise.race([
              Promise.allSettled([draining, client?.connection.cancelSettled]).then(() => true),
              new Promise<false>((resolve) => {
                timer = setTimeout(resolve, cancellationBudget, false);
              }),
            ]).finally(() => clearTimeout(timer));
            if (!settled) throw new Error("Rate limit cleanup failed");
          } catch (error) {
            cleanupFailures.push({ phase: "cancel", error });
          }
        }
        // Ending the pool also abandons a connect still in flight. Attach the close
        // rejection immediately, so a close failure cannot strand an owned promise.
        const closing = closeSession(pool, client).catch((error) => {
          cleanupFailures.push({ phase: "close", error });
        });
        // A connect that settles after shutdown began is closed here and never runs SQL.
        if (connectionAttempt && !connected)
          await connectionAttempt.then(
            (late) =>
              late.client.end().catch((error) => {
                cleanupFailures.push({ phase: "close", error });
              }),
            (error) => {
              cleanupFailures.push({ phase: "connect-drain", error });
            },
          );
        if (draining)
          await draining.catch((error) => {
            cleanupFailures.push({ phase: "query-drain", error });
          });
        await closing;
      } finally {
        clearInterval(wake);
      }
    }));
  }
  const stop = () => {
    // Capture the initiator before cancellation/destruction can synchronously
    // reenter the driver or reject the owned query. The wrapper is the presence
    // flag: null, false, zero and empty-string abort reasons are actual causes.
    primaryFailure ??= {
      error: options.signal?.aborted ? options.signal.reason : new Error("Rate limit cleanup failed"),
    };
    stopped = true;
    // Own the callback's rejection immediately; the caller also awaits the same
    // shutdown promise below, so no event handler creates an unhandled rejection.
    void shutdown().catch(() => {});
  };
  function assertWork(): void {
    if (stopped || performance.now() >= workDeadline) throw new Error("Rate limit cleanup failed");
    options.signal?.throwIfAborted();
  }
  async function query<R extends object = SessionRow>(
    text: string,
    values?: unknown[],
    confirmed?: () => void,
  ): Promise<SessionResult<R>> {
    assertWork();
    if (!client) throw new Error("Rate limit cleanup failed");
    const pending = client.query<R>(text, values, { signal: cancellation.signal });
    activeQuery = pending;
    try {
      const result = await pending;
      // A fulfilled COMMIT confirms durability even if expiry makes the run a
      // failure. Never infer a commit from a sent packet or rejected query.
      confirmed?.();
      assertWork();
      return result;
    } finally {
      activeQuery = undefined;
    }
  }
  // Start shutdown early enough for cancellation. The absolute watchdog and
  // abort listener remain active until owned close settles. Event-loop stalls
  // can delay settlement, but must never produce success past the deadline.
  const workTimer = setTimeout(stop, remaining());
  const timer = setTimeout(stop, Math.max(0, deadline - performance.now()));
  options.signal?.addEventListener("abort", stop, { once: true });
  async function run(): Promise<RateLimitCleanupResult> {
    let hasMore = false;
    let oldestExpiredAgeMs: number | null = null;
    let stoppedBy: RateLimitCleanupResult["stoppedBy"] = "empty";
    options.signal?.throwIfAborted();
    if (performance.now() >= workDeadline) throw new Error();
    const attempt = pool.connect();
    connectionAttempt = attempt;
    const checkout = await attempt;
    if (stopped) throw new Error("Rate limit cleanup failed");
    connected = true;
    client = createDatabaseSession(checkout.client);
    assertWork();
    const version = await query<{ server_version_num: string }>("SHOW server_version_num");
    if (Math.floor(Number(version.rows[0]?.server_version_num) / 10000) !== 18) throw new Error();
    const metadata = await query<{ owned: boolean; framework: boolean; migrations: boolean }>(
      `SELECT nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned,
        to_regclass($2) IS NOT NULL AS framework, to_regclass($3) IS NOT NULL AS migrations
        FROM pg_namespace WHERE nspname=$1`,
      [options.metadataNamespace, `${schema}.framework_migrations`, `${schema}.migration_history`],
    );
    const ownership = metadata.rows[0];
    if (!ownership?.owned || !ownership.framework || !ownership.migrations) throw new Error();
    const history = await query<{ version: number; hash: string }>(
      `SELECT version,hash FROM ${schema}.framework_migrations ORDER BY version`,
    );
    const readiness = classifyFrameworkHistory({
      metadataExists: true,
      frameworkHistoryExists: true,
      migrationHistoryExists: true,
      applied: history.rows,
      expected: frameworkMigrations(options.metadataNamespace),
    });
    if (readiness.state !== "current") throw new Error();
    const table = `${schema}.rate_limit_buckets`;
    while (batches < maxBatches) {
      if (performance.now() >= workDeadline - closeReserveMs) {
        if (batches === 0) throw new Error();
        stoppedBy = "time-budget";
        break;
      }
      options.signal?.throwIfAborted();
      await query("BEGIN");
      // The transport watchdog bounds the whole run; server timeouts also
      // release locks if the caller disconnects while PostgreSQL is working.
      await query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [
        `${remaining()}ms`,
      ]);
      const before = await query<{ now: string }>(
        "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
      );
      const selected = await query<{
        application_namespace: string;
        mount_path: string;
        policy_name: string;
        version: number;
        key_hex: string;
      }>(
        `SELECT application_namespace,mount_path,policy_name,version,encode(key_digest,'hex') AS key_hex
        FROM ${table} WHERE cleanup_after_ms <= $1::bigint
        ORDER BY cleanup_after_ms LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [before.rows[0]!.now, batchSize],
      );
      const after = await query<{ now: string }>(
        "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
      );
      const deletion = await query(
        `DELETE FROM ${table} AS bucket
        USING jsonb_to_recordset($1::jsonb) AS selected(
          application_namespace text,mount_path text,policy_name text,version integer,key_hex text)
        WHERE bucket.application_namespace=selected.application_namespace
          AND bucket.mount_path=selected.mount_path AND bucket.policy_name=selected.policy_name
          AND bucket.version=selected.version AND bucket.key_digest=decode(selected.key_hex,'hex')
          AND bucket.cleanup_after_ms <= $2::bigint`,
        [JSON.stringify(selected.rows), after.rows[0]!.now],
      );
      const probeTime = await query<{ now: string }>(
        "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
      );
      // These MVCC index probes deliberately do not skip row locks. A locked
      // eligible row is backlog even when selection returned zero rows.
      const probe = await query<{ has_more: boolean; oldest: string | null }>(
        `SELECT EXISTS(SELECT 1 FROM ${table} WHERE cleanup_after_ms <= $1::bigint LIMIT 1) AS has_more,
        (SELECT cleanup_after_ms FROM ${table} WHERE cleanup_after_ms <= $1::bigint
          ORDER BY cleanup_after_ms LIMIT 1) AS oldest`,
        [probeTime.rows[0]!.now],
      );
      options.signal?.throwIfAborted();
      await query("COMMIT", undefined, () => {
        removed += deletion.rowCount ?? 0;
        batches++;
      });
      hasMore = probe.rows[0]!.has_more;
      oldestExpiredAgeMs =
        probe.rows[0]!.oldest === null
          ? null
          : Math.max(0, Number(probeTime.rows[0]!.now) - Number(probe.rows[0]!.oldest));
      if (!hasMore) break;
      stoppedBy = "batch-budget";
    }
    return { removed, batches, hasMore, oldestExpiredAgeMs, stoppedBy };
  }
  let result: RateLimitCleanupResult | undefined;
  try {
    // Await run even after stop. Shutdown interrupts its native query/connect;
    // a fulfilled COMMIT after stop still cannot turn an ambiguous run green.
    result = await run();
    if (stopped || options.signal?.aborted) throw new Error();
  } catch (error) {
    primaryFailure ??= { error };
  } finally {
    clearTimeout(workTimer);
    try {
      await shutdown();
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
    }
  }
  if (stopped || options.signal?.aborted || performance.now() >= deadline)
    primaryFailure ??= {
      error: options.signal?.aborted ? options.signal.reason : new Error("Rate limit cleanup failed"),
    };
  if (primaryFailure || cleanupFailures.length || !result) {
    // Safe additive failure accounting; the successful result shape is unchanged.
    throw cleanupFailed({ primary: primaryFailure, cleanup: cleanupFailures }, removed, batches);
  }
  return result;
}
