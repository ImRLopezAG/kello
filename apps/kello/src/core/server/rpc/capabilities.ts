import { Procedure } from "@orpc/server";
import type { AnyProcedure, InferRouterInputs } from "@orpc/server";
import * as v from "valibot";
import type { StorageAuthorization } from "../storage/intents";
import { storageUploadValidator } from "../storage/contracts";
import type { StorageObjectCreatedEvent } from "../storage/contracts";
import { cronScheduleValidator } from "../jobs/durable-crons";
import type { CronPolicy } from "../jobs/durable-crons";
import { scheduleOptions } from "../jobs/contracts";
import { encodeRpcJobCall } from "../jobs/rpc-contracts";
import { rpcCronValidator } from "../jobs/rpc-crons";
import type { RpcCronDefinition } from "../jobs/rpc-crons";
import { rpcStorageHandlerValidator } from "../storage/rpc-events";
import type { RpcStorageHandler } from "../storage/rpc-events";
import type { InternalProcedureEntry } from "../jobs/rpc-queue";
import { rpcValue } from "./serialization";
import type { RpcValue } from "./serialization";

interface ProcedureTarget {
  readonly procedure: AnyProcedure;
  readonly maxAttempts: number;
  readonly retryDelaySeconds?: number | undefined;
}
export interface ProcedureCron extends ProcedureTarget {
  readonly schedule: string;
  readonly input: RpcValue;
}
export interface ProcedureStorageDefinition {
  readonly buckets: Readonly<Record<string, { readonly onObjectCreated?: ProcedureTarget }>>;
  readonly authorize: (context: StorageAuthorization) => Promise<void>;
}
const targets = new WeakSet<object>();
const crons = new WeakSet<object>();
const storages = new WeakSet<object>();
const policySchema = v.strictObject({
  maxAttempts: scheduleOptions.entries.maxAttempts,
  retryDelaySeconds: v.optional(scheduleOptions.entries.retryDelaySeconds.wrapped),
});

export function procedureCron<P extends AnyProcedure>(
  expression: string,
  procedure: P,
  input: NoInfer<InferRouterInputs<P>>,
  policy: CronPolicy = {},
): ProcedureCron {
  if (!(procedure instanceof Procedure)) throw new Error("Cron requires a native procedure");
  const definition = Object.freeze({
    procedure,
    schedule: v.parse(cronScheduleValidator, expression),
    input: structuredClone(v.parse(rpcValue, input)),
    ...v.parse(policySchema, policy),
  });
  crons.add(definition);
  return definition;
}

export function procedureObjectCreated<P extends AnyProcedure>(
  procedure: StorageObjectCreatedEvent extends InferRouterInputs<P> ? P : never,
  policy: CronPolicy = {},
): ProcedureTarget {
  if (!(procedure instanceof Procedure)) throw new Error("Storage event requires a native procedure");
  const definition = Object.freeze({ procedure, ...v.parse(policySchema, policy) });
  targets.add(definition);
  return definition;
}

export function defineProcedureStorage(
  options: {
    readonly buckets: ProcedureStorageDefinition["buckets"];
    readonly authorize?: (context: StorageAuthorization) => void | Promise<void>;
  } = { buckets: {} },
): ProcedureStorageDefinition {
  const buckets: Record<string, { readonly onObjectCreated?: ProcedureTarget }> = {};
  for (const [name, bucket] of Object.entries(options.buckets)) {
    v.parse(storageUploadValidator.entries.bucket, name);
    if (bucket.onObjectCreated && !targets.has(bucket.onObjectCreated))
      throw new Error("Expected procedureObjectCreated's result");
    buckets[name] = Object.freeze({ ...bucket });
  }
  const authorize =
    options.authorize ??
    (() => {
      throw new Error("Storage access denied");
    });
  v.parse(v.function(), authorize);
  const definition = Object.freeze({
    buckets: Object.freeze(buckets),
    async authorize(context: StorageAuthorization): Promise<void> {
      await authorize(context);
    },
  });
  storages.add(definition);
  return definition;
}
export function isProcedureStorage(value: unknown): value is ProcedureStorageDefinition {
  return value instanceof Object && storages.has(value);
}
export function isProcedureCrons(value: unknown): value is Readonly<Record<string, ProcedureCron>> {
  return v.is(
    v.record(
      v.string(),
      v.custom<ProcedureCron>((entry) => entry instanceof Object && crons.has(entry)),
    ),
    value,
  );
}

/** Resolve authored procedure objects against the exact generated internal graph.
 * The same compiler validates CLI input and constructs the deployed runtime. */
export function compileProcedureCapabilities(options: {
  readonly version: string;
  readonly scope?: string;
  readonly internal: readonly InternalProcedureEntry[];
  readonly crons: Readonly<Record<string, ProcedureCron>>;
  readonly storage: ProcedureStorageDefinition;
  readonly maxAttempts: number;
}) {
  if (!isProcedureCrons(options.crons) || !isProcedureStorage(options.storage))
    throw new Error("Invalid procedure capabilities");
  const paths = new Map<AnyProcedure, readonly string[]>();
  for (const entry of options.internal) {
    if ((entry.scope ?? "") !== (options.scope ?? "")) continue;
    if (paths.has(entry.procedure)) throw new Error("Internal procedure has multiple paths");
    paths.set(entry.procedure, entry.path);
  }
  function path(target: ProcedureTarget): readonly string[] {
    const path = paths.get(target.procedure);
    if (!path) throw new Error("Durable capability requires a registered internal procedure");
    if (target.maxAttempts > options.maxAttempts) throw new Error("Durable capability exceeds configured attempts");
    return path;
  }
  const compiledCrons: Record<string, RpcCronDefinition> = {};
  for (const [name, declaration] of Object.entries(options.crons)) {
    v.parse(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)), name);
    compiledCrons[name] = v.parse(rpcCronValidator, {
      schedule: declaration.schedule,
      call: encodeRpcJobCall(options.version, path(declaration), declaration.input, options.scope),
      maxAttempts: declaration.maxAttempts,
      retryDelaySeconds: declaration.retryDelaySeconds,
    });
  }
  const handlers: Record<string, RpcStorageHandler> = {};
  for (const [bucket, declaration] of Object.entries(options.storage.buckets)) {
    const target = declaration.onObjectCreated;
    if (target)
      handlers[bucket] = v.parse(rpcStorageHandlerValidator, {
        path: path(target),
        scope: options.scope || undefined,
        maxAttempts: target.maxAttempts,
        retryDelaySeconds: target.retryDelaySeconds,
      });
  }
  return Object.freeze({ crons: Object.freeze(compiledCrons), handlers: Object.freeze(handlers) });
}
