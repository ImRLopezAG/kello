import pg from "pg";
import { quoteIdentifier } from "./connection";
import { frameworkMigrations } from "./bootstrap";
import { classifyFrameworkHistory } from "./framework-history";
import { cancelDatabaseStatement } from "../../core/server/database/cancel";

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
  if (url.hostname.endsWith(".neon.tech")) url.searchParams.set("sslmode", "verify-full");
  const deadline = started + maxDurationMs;
  // Reserve transport cancellation and local close time inside the same run
  // budget. Short runs split their budget rather than adding a 2s cancel tail.
  const closeReserveMs = Math.min(50, maxDurationMs / 10);
  const workDeadline = deadline - Math.min(2000, maxDurationMs / 2) - closeReserveMs;
  const remaining = () => Math.max(1, Math.ceil(workDeadline - performance.now()));
  let client: pg.Client;
  try {
    client = new pg.Client({
      connectionString: url.href,
      connectionTimeoutMillis: remaining(),
      statement_timeout: remaining(),
      lock_timeout: remaining(),
      application_name: "kello-rate-limits-cleanup",
      options: "-c search_path=pg_catalog",
    });
  } catch (error) {
    throw cleanupFailed({ primary: { error }, cleanup: [] });
  }
  let activeQuery: Promise<unknown> | undefined;
  let connected = false;
  let connectionAttempt: Promise<pg.Client> | undefined;
  let stopped = false;
  let shutdownPromise: Promise<void> | undefined;
  let removed = 0;
  let batches = 0;
  let primaryFailure: { error: unknown } | undefined;
  const cleanupFailures: { phase: "cancel" | "destroy" | "connect-drain" | "query-drain" | "close"; error: unknown }[] =
    [];
  // One owner of shutdown, including when the run fails while cancellation is
  // still in flight. Keep the original pooler mapping until cancel settles.
  function shutdown(): Promise<void> {
    // Install the shared promise before any driver callback can reenter stop.
    return (shutdownPromise ??= Promise.resolve().then(async () => {
      const draining = activeQuery;
      if (draining) {
        try {
          // Never pass zero/negative or extend the absolute run budget. Required
          // close/drain still runs if no cancellation budget remains.
          const cancellationBudget = deadline - performance.now() - closeReserveMs;
          if (cancellationBudget <= 0) throw new Error("Rate limit cleanup failed");
          await cancelDatabaseStatement(client, cancellationBudget);
        } catch (error) {
          cleanupFailures.push({ phase: "cancel", error });
        }
      }
      if (connectionAttempt && !connected) {
        // pg.end() marks a connecting Client as ending and can suppress its
        // connect rejection. Destroy first, then await that rejection before end.
        try {
          client.connection.stream.destroy();
        } catch (error) {
          cleanupFailures.push({ phase: "destroy", error });
        }
        await connectionAttempt.catch((error) => {
          cleanupFailures.push({ phase: "connect-drain", error });
        });
      }
      // Attach the close rejection immediately, even while query drain is still
      // pending. A close failure must not strand either owned promise.
      let closing: Promise<void> | undefined;
      try {
        closing = client.end().catch((error) => {
          cleanupFailures.push({ phase: "close", error });
        });
      } catch (error) {
        cleanupFailures.push({ phase: "close", error });
      }
      // Cancel has settled; this dedicated socket may now be destroyed. Await
      // end's native close event rather than wait indefinitely for a peer EOF.
      try {
        client.connection.stream.destroy();
      } catch (error) {
        cleanupFailures.push({ phase: "destroy", error });
      }
      if (draining)
        await draining.catch((error) => {
          cleanupFailures.push({ phase: "query-drain", error });
        });
      await closing;
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
  // Include idle connection loss as an operation failure, without publishing
  // provider details. Query/close callbacks join this same shutdown.
  client.on("error", (error) => {
    if (shutdownPromise) {
      cleanupFailures.push({ phase: "close", error });
      return;
    }
    primaryFailure ??= { error };
    stop();
  });
  function assertWork(): void {
    if (stopped || performance.now() >= workDeadline) throw new Error("Rate limit cleanup failed");
    options.signal?.throwIfAborted();
  }
  async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
    confirmed?: () => void,
  ): Promise<pg.QueryResult<R>> {
    assertWork();
    const pending = client.query<R>(text, values);
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
    connectionAttempt = client.connect();
    await connectionAttempt;
    connected = true;
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
