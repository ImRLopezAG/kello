import { ownRpcDatabaseWork } from "../rpc/database";
import { createRpcScheduler } from "./rpc-scheduler";
import type { createRpcJobQueue, InternalProcedureEntry } from "./rpc-queue";

/** Runtime binding supplies this capability only to the compiled project graph. */
export function createTransactionalRpcScheduler(options: {
  readonly version: string;
  readonly scope?: string;
  readonly internal: readonly InternalProcedureEntry[];
  readonly queue: Pick<ReturnType<typeof createRpcJobQueue>, "enqueue">;
}) {
  return createRpcScheduler(
    options.version,
    options.internal,
    (envelope, policy) => ownRpcDatabaseWork((db, identity) => options.queue.enqueue(db, envelope, identity, policy)),
    (work) => ownRpcDatabaseWork(work),
    options.scope,
  );
}
