import { setTimeout } from "node:timers/promises";
import type { AnyRelations } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DatabaseConnection } from "./database/connection";
import { withTransactionSignal } from "./database/connection";
import { publishRuntimeMetric } from "./observability";

export interface TransactionOptions {
  /** Total attempts, including the first. Only serialization failures and deadlocks retry. */
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
}

export class TransactionConflictError extends Error {
  constructor(cause: Error) {
    super("Database conflict retry budget exhausted", { cause });
    this.name = "TransactionConflictError";
  }
}

function retryable(error: Error): boolean {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if ("code" in current && (current.code === "40001" || current.code === "40P01")) return true;
    if (!(current.cause instanceof Error)) return false;
    current = current.cause;
  }
  return false;
}

/** The entire callback retries. Keep external effects outside mutation callbacks. */
export async function runFunctionTransaction<Relations extends AnyRelations, Result>(
  connection: DatabaseConnection<Relations>,
  kind: "query" | "mutation",
  operation: (tx: Parameters<Parameters<NodePgDatabase<Relations>["transaction"]>[0]>[0]) => Promise<Result>,
  options: TransactionOptions = {},
): Promise<Result> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)
    throw new Error("maxAttempts must be an integer from 1 to 10");
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    if (attempt > 1) publishRuntimeMetric({ type: "transaction.retry", kind, attempt });
    try {
      return await withTransactionSignal(options.signal, () =>
        connection.transaction(
          async (tx) => {
            options.signal?.throwIfAborted();
            const result = await operation(tx);
            options.signal?.throwIfAborted();
            return result;
          },
          kind === "query"
            ? { isolationLevel: "repeatable read", accessMode: "read only" }
            : { isolationLevel: "serializable", accessMode: "read write" },
        ),
      );
    } catch (cause) {
      options.signal?.throwIfAborted();
      if (!(cause instanceof Error) || !retryable(cause)) throw cause;
      if (attempt >= maxAttempts) throw new TransactionConflictError(cause);
      await setTimeout(Math.min(10 * 2 ** (attempt - 1), 250), undefined, { signal: options.signal });
    }
  }
}
