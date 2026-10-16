import { createAdapterFactory } from "@better-auth/core/db/adapter";
import type { DBAdapterInstance } from "@better-auth/core/db/adapter";
import type { NativeAuth } from "./definition";
import { compileBetterAuthSchema } from "./schema";
import type { BetterAuthSchema } from "./schema";

function rejectInitializationQuery(): never {
  throw new Error("Better Auth schema initialization must not access the database");
}

const planningDatabase = createAdapterFactory({
  config: { adapterId: "loom-schema-planning", supportsNumericIds: true },
  adapter: () => ({
    create: rejectInitializationQuery,
    findOne: rejectInitializationQuery,
    findMany: rejectInitializationQuery,
    count: rejectInitializationQuery,
    update: rejectInitializationQuery,
    updateMany: rejectInitializationQuery,
    delete: rejectInitializationQuery,
    deleteMany: rejectInitializationQuery,
    consumeOne: rejectInitializationQuery,
    incrementOne: rejectInitializationQuery,
  }),
});

/** Await native initialization before admitting a candidate; never run schema SQL here. */
export async function validateBetterAuthInstance<Auth extends NativeAuth>(
  auth: Auth,
  database: DBAdapterInstance,
  namespace: string,
  expectedFingerprint?: string,
) {
  // Capture before async plugin initialization can mutate the options in place.
  // Observe both outcomes even if compilation fails, so initialization cannot leak rejections.
  let declared: BetterAuthSchema;
  try {
    declared = compileBetterAuthSchema(auth.options, namespace);
  } catch (cause) {
    await Promise.allSettled([auth.$context]);
    throw cause;
  }
  const context = await auth.$context;
  if (auth.options.database !== database || context.options.database !== database)
    throw new Error("Better Auth must use the database binding supplied by Kello");
  const effective = compileBetterAuthSchema(context.options, namespace);
  if (declared.fingerprint !== effective.fingerprint)
    throw new Error("Better Auth plugins must declare schema before initialization");
  if (expectedFingerprint && expectedFingerprint !== effective.fingerprint)
    throw new Error("Better Auth runtime schema differs from its planned fingerprint");
  return effective;
}

/** Resolve twice without database access to detect configuration-dependent schema drift. */
export async function resolveBetterAuthSchema(create: (database: DBAdapterInstance) => NativeAuth, namespace: string) {
  const first = await validateBetterAuthInstance(create(planningDatabase), planningDatabase, namespace);
  const second = await validateBetterAuthInstance(create(planningDatabase), planningDatabase, namespace);
  if (first.fingerprint !== second.fingerprint)
    throw new Error("Better Auth configuration produced a nondeterministic schema");
  return first;
}
