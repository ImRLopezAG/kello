import type { AnyProcedure } from "@orpc/server";
import * as v from "valibot";
import { createDurableJobQueue } from "./durable-queue";
import type { DurableQueueOptions } from "./durable-queue";
import { rpcJobCall } from "./rpc-contracts";
import type { RpcJobCall } from "./rpc-contracts";
import { compileJobMigrations } from "./rpc-migrations";
import type { JobMigration } from "./rpc-migrations";

export interface InternalProcedureEntry {
  readonly scope?: string;
  readonly path: readonly string[];
  readonly procedure: AnyProcedure;
}

/** Construct only from the generated internal graph, never from client input. */
export function createRpcJobQueue(
  options: Omit<DurableQueueOptions<RpcJobCall>, "parseCall" | "parseClaim" | "prepare"> & {
    readonly internal: readonly InternalProcedureEntry[];
    readonly migrations?: readonly JobMigration[];
  },
) {
  const migrations = compileJobMigrations({
    version: options.version,
    internal: options.internal,
    migrations: options.migrations ?? [],
  });
  return createDurableJobQueue({
    ...options,
    parseCall: (input) => v.parse(rpcJobCall, input),
    parseClaim: migrations.resolve,
    prepare: async (envelope) => {
      await migrations.resolve(envelope);
    },
  });
}
