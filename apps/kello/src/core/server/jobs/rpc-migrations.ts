import { call, Procedure } from "@orpc/server";
import type { AnyProcedure, AnySchema, InferRouterInputs, InferSchemaOutput } from "@orpc/server";
import * as v from "valibot";
import { jobCall } from "./contracts";
import { rpcJobCall, decodeRpcJobInput, encodeRpcJobCall } from "./rpc-contracts";
import type { RpcJobCall } from "./rpc-contracts";
import type { InternalProcedureEntry } from "./rpc-queue";
import { rpcValue } from "../rpc/serialization";
import type { RpcValue } from "../rpc/serialization";
import type { JsonValue } from "../../schema/fields";

const sourceSchema = v.variant("protocol", [
  v.strictObject({
    protocol: v.literal("loom-legacy-1"),
    version: jobCall.entries.version,
    name: jobCall.entries.name,
    kind: jobCall.entries.kind,
  }),
  v.strictObject({
    protocol: v.literal("loom-orpc-2"),
    version: rpcJobCall.entries.version,
    path: rpcJobCall.entries.path,
    scope: rpcJobCall.entries.scope,
  }),
]);
export type JobMigrationSource = v.InferOutput<typeof sourceSchema>;
export interface JobMigration {
  readonly from: JobMigrationSource;
  readonly to: AnyProcedure;
  readonly transform: (input: RpcValue) => Promise<RpcValue>;
}
const definitions = new WeakSet<object>();

/** Compatibility reader for retained, unmigrated durable work. */
export function isLegacyJobCall(value: unknown): value is v.InferOutput<typeof jobCall> {
  return v.is(jobCall, value);
}

/** Explicit, version-specific conversion. The source schema validates stored
 * input before conversion; the target's native input schemas validate the result.
 * Transformations must be deterministic and have no external effects. */
export function defineJobMigration<Input extends AnySchema, Target extends AnyProcedure>(options: {
  readonly from: JobMigrationSource;
  readonly input: Input;
  readonly to: Target;
  readonly transform: (input: InferSchemaOutput<Input>) => NoInfer<InferRouterInputs<Target>>;
}): JobMigration {
  const from = structuredClone(v.parse(sourceSchema, options.from));
  if (!(options.to instanceof Procedure)) throw new Error("Job migration requires a native procedure");
  if (from.protocol === "loom-orpc-2") Object.freeze(from.path);
  const target = options.to;
  const definition = target["~orpc"];
  if (definition.disableInputValidation) throw new Error("Job migration target requires input validation");
  const validation = new Procedure({
    ...definition,
    orderedMiddlewares: [],
    outputSchemas: [],
    handler: () => undefined,
  });
  const input = options.input;
  const transform = options.transform;
  const migration = Object.freeze({
    from: Object.freeze(from),
    to: target,
    async transform(value: RpcValue): Promise<RpcValue> {
      const parsed = await input["~standard"].validate(structuredClone(value));
      if (parsed.issues) throw new Error("Stored job input does not satisfy its migration schema");
      const converted = structuredClone(v.parse(rpcValue, transform(parsed.value)));
      await call(validation, converted, { context: {} });
      return converted;
    },
  });
  definitions.add(migration);
  return migration;
}
export function isJobMigrations(value: unknown): value is readonly JobMigration[] {
  return v.is(v.array(v.custom<JobMigration>((item) => item instanceof Object && definitions.has(item))), value);
}
function key(source: JobMigrationSource): string {
  return source.protocol === "loom-legacy-1"
    ? JSON.stringify([source.protocol, source.version, source.name, source.kind])
    : JSON.stringify([source.protocol, source.version, source.scope ?? "", source.path]);
}

/** The original durable envelope is never modified. Conversion produces only
 * the in-memory invocation sent to the current, registered internal procedure. */
export function compileJobMigrations(options: {
  readonly version: string;
  readonly internal: readonly InternalProcedureEntry[];
  readonly migrations: readonly JobMigration[];
}) {
  v.parse(rpcJobCall.entries.version, options.version);
  if (!isJobMigrations(options.migrations)) throw new Error("Expected native job migration declarations");
  const paths = new Map<AnyProcedure, InternalProcedureEntry[]>();
  const validators = new Map<string, AnyProcedure>();
  for (const entry of options.internal) {
    const path = v.parse(rpcJobCall.entries.path, entry.path);
    paths.set(entry.procedure, [...(paths.get(entry.procedure) ?? []), { ...entry, path }]);
    const targetKey = JSON.stringify([entry.scope ?? "", path]);
    const definition = entry.procedure["~orpc"];
    if (definition.disableInputValidation) throw new Error("Job migration target requires input validation");
    if (validators.has(targetKey)) throw new Error("Duplicate internal procedure path");
    validators.set(
      targetKey,
      new Procedure({ ...definition, orderedMiddlewares: [], outputSchemas: [], handler: () => undefined }),
    );
  }
  const mappings = new Map<
    string,
    { readonly path: readonly string[]; readonly scope?: string; readonly transform: JobMigration["transform"] }
  >();
  const declarations: { readonly from: JobMigrationSource; readonly to: readonly string[]; readonly scope?: string }[] =
    [];
  for (const migration of options.migrations) {
    const targets = paths.get(migration.to);
    if (!targets?.length) throw new Error("Job migration target must be a registered internal procedure");
    if (targets.length !== 1) throw new Error("Job migration target has ambiguous component scope");
    const { path, scope } = targets[0]!;
    const source = structuredClone(v.parse(sourceSchema, migration.from));
    if (source.version === options.version) throw new Error("Job migration source must be a previous version");
    const id = key(source);
    if (mappings.has(id)) throw new Error("Duplicate job migration source");
    mappings.set(
      id,
      scope ? { path, scope, transform: migration.transform } : { path, transform: migration.transform },
    );
    if (source.protocol === "loom-orpc-2") Object.freeze(source.path);
    const declaration = { from: Object.freeze(source), to: Object.freeze([...path]) };
    declarations.push(Object.freeze(scope ? { ...declaration, scope } : declaration));
  }
  return Object.freeze({
    declarations: Object.freeze(declarations),
    async resolve(input: JsonValue | RpcJobCall): Promise<RpcJobCall> {
      const native = v.safeParse(rpcJobCall, input);
      if (native.success && native.output.version === options.version) {
        const validation = validators.get(JSON.stringify([native.output.scope ?? "", native.output.path]));
        if (!validation) throw new Error("Internal job procedure not found");
        await call(validation, decodeRpcJobInput(native.output), { context: {} });
        return native.output;
      }
      const legacy = native.success ? undefined : v.safeParse(jobCall, input);
      let source: JobMigrationSource;
      let value: RpcValue;
      if (native.success) {
        source = { protocol: "loom-orpc-2", version: native.output.version, path: native.output.path };
        if (native.output.scope) source.scope = native.output.scope;
        value = decodeRpcJobInput(native.output);
      } else if (legacy?.success) {
        source = {
          protocol: "loom-legacy-1",
          version: legacy.output.version,
          name: legacy.output.name,
          kind: legacy.output.kind,
        };
        value = v.parse(rpcValue, legacy.output.args);
      } else throw new Error("Unsupported durable job envelope");
      const migration = mappings.get(key(source));
      if (!migration) throw new Error("No explicit migration for durable job");
      return encodeRpcJobCall(options.version, migration.path, await migration.transform(value), migration.scope);
    },
  });
}
