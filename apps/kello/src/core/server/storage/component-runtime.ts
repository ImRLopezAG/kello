import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import * as v from "valibot";
import { createStorageIntents } from "./intents";
import type { StorageIntentsOptions } from "./intents";
import { createStorageCleanup } from "./cleanup";
import { createRpcStorageEventDispatcher } from "./rpc-events";
import type { RpcStorageHandler } from "./rpc-events";
import type { StorageDelivery } from "./durable-events";
import { storageIntentValidator } from "./contracts";
import { storageUploadPrefix } from "./keys";
import { rpcJobCall } from "../jobs/rpc-contracts";
import type { createRpcJobQueue } from "../jobs/rpc-queue";
import type { ProcedureStorageDefinition } from "../rpc/capabilities";

/** One generation owns this immutable routing map. Stored intent ownership, not
 * a caller-supplied scope or bucket name, selects provider callback dispatch. */
export function createComponentStorageRuntime(
  options: Omit<StorageIntentsOptions, "buckets" | "authorize"> & {
    readonly version: string;
    readonly queue: Pick<ReturnType<typeof createRpcJobQueue>, "enqueue">;
    readonly scopes: readonly {
      readonly scope: string;
      readonly storage: ProcedureStorageDefinition;
      readonly handlers: Readonly<Record<string, RpcStorageHandler>>;
    }[];
    readonly assertIngress?: (signal: AbortSignal, transaction: StorageIntentsOptions["db"]) => Promise<void>;
    readonly rootEvents?: ReturnType<typeof createRpcStorageEventDispatcher>;
  },
) {
  const instances = new Map<
    string,
    {
      readonly intents: ReturnType<typeof createStorageIntents>;
      readonly cleanup: ReturnType<typeof createStorageCleanup>;
    }
  >();
  const byDeployment = new Map<string, ReturnType<typeof createRpcStorageEventDispatcher>>();
  if (options.rootEvents) byDeployment.set(options.deployment, options.rootEvents);
  for (const configured of options.scopes) {
    const scope = v.parse(rpcJobCall.entries.scope.wrapped, configured.scope);
    if (instances.has(scope)) throw new Error("Duplicate component storage scope");
    for (const handler of Object.values(configured.handlers))
      if (handler.scope !== scope) throw new Error("Storage callback belongs to a different component scope");
    const deployment = `component:${createHash("sha256")
      .update(JSON.stringify([options.deployment, scope]))
      .digest("hex")}`;
    const common = {
      ...options,
      deployment,
      ownerScope: scope,
      buckets: Object.keys(configured.storage.buckets),
      authorize: configured.storage.authorize,
    };
    const intents = createStorageIntents(common);
    const events = createRpcStorageEventDispatcher({ ...common, intents, handlers: configured.handlers });
    const cleanup = createStorageCleanup(common);
    instances.set(scope, Object.freeze({ intents, cleanup }));
    byDeployment.set(deployment, events);
  }
  const prefix = storageUploadPrefix(options.projectId, options.branchId);
  const table = sql`${sql.identifier(options.metadataNamespace)}.${sql.identifier("storage_intents")}`;
  return Object.freeze({
    forScope(scope: string) {
      return instances.get(scope)?.intents;
    },
    async receive(delivery: StorageDelivery, signal: AbortSignal = new AbortController().signal) {
      signal.throwIfAborted();
      await options.assertActive(signal);
      if (!delivery.key.startsWith(prefix)) throw new Error("Unbound storage event");
      const id = v.parse(storageIntentValidator.entries.id, delivery.key.slice(prefix.length));
      if (delivery.key !== `${prefix}${id}`) throw new Error("Unbound storage event");
      const found = await options.db.execute<{ deployment: string }>(sql`
        SELECT deployment FROM ${table}
        WHERE id = ${id}::uuid AND project_id = ${options.projectId} AND branch_id = ${options.branchId}
      `);
      if (found.rows.length !== 1) throw new Error("Unbound storage event");
      const events = byDeployment.get(found.rows[0]!.deployment);
      if (!events) throw new Error("Storage event owner is no longer mounted");
      signal.throwIfAborted();
      return events.receive(delivery, signal);
    },
    async reconcile(limit = 25, signal: AbortSignal = new AbortController().signal) {
      const total = { claimed: 0, dispatched: 0, failed: 0, pending: 0, inactive: false };
      // Includes the root only when explicitly registered for this generation.
      for (const events of byDeployment.values()) {
        const result = await events.reconcile(limit, signal);
        total.claimed += result.claimed;
        total.dispatched += result.dispatched;
        total.failed += result.failed;
        total.pending += result.pending;
        total.inactive ||= result.inactive;
      }
      return Object.freeze(total);
    },
    async cleanup(limit = 25, signal: AbortSignal = new AbortController().signal) {
      const total = { processed: 0, failed: 0 };
      for (const instance of instances.values()) {
        const result = await instance.cleanup.run(limit, signal);
        total.processed += result.processed;
        total.failed += result.failed;
      }
      return Object.freeze(total);
    },
  });
}
