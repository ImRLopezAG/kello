import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import * as v from "valibot";
import type { ActivationDatabase } from "../../server/runtime-contracts";

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const activation = v.strictObject({
  metadataNamespace: v.pipe(v.string(), v.regex(/^loom_[a-z0-9_]{1,58}$/)),
  deployment: identifier,
  version: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  projectId: identifier,
  branchId: identifier,
  branchName: identifier,
  endpointHost: v.pipe(v.string(), v.regex(/^[a-z0-9.-]+$/)),
  databaseName: identifier,
});
export type NeonActivationOptions = v.InferInput<typeof activation>;

/** Binding comes from a verified deployment receipt. Never override NEON_BRANCH or DATABASE_URL at deploy time. */
export function createNeonActivationVerifier(options: NeonActivationOptions) {
  return createVerifier(options, ["active"]);
}

/** Only the authenticated startup probe uses this verifier; never dispatch application work with it. */
export function createNeonPreparationVerifier(options: NeonActivationOptions) {
  return createVerifier(options, ["quarantined", "active"]);
}

/** Local tooling supplies verified branch identity and captures credentials separately for each runtime generation. */
export function createDevelopmentActivationVerifier(
  options: NeonActivationOptions,
  credentials: { readonly connectionString: string; readonly activationToken: string },
) {
  const captured = {
    branchName: options.branchName,
    connectionString: credentials.connectionString,
    token: credentials.activationToken,
  };
  return createVerifier(options, ["active"], () => captured);
}

/** Tooling-only assembly check. Switch to the active verifier before publishing a runtime. */
export function createDevelopmentPreparationVerifier(
  options: NeonActivationOptions,
  credentials: { readonly connectionString: string; readonly activationToken: string },
) {
  const captured = {
    branchName: options.branchName,
    connectionString: credentials.connectionString,
    token: credentials.activationToken,
  };
  return createVerifier(options, ["quarantined", "active"], () => captured);
}

function environmentCredentials() {
  return {
    branchName: process.env.NEON_BRANCH,
    connectionString: process.env.DATABASE_URL,
    token: process.env.LOOM_ACTIVATION_TOKEN,
  };
}

function createVerifier(
  options: NeonActivationOptions,
  states: readonly string[],
  credentials: () => ReturnType<typeof environmentCredentials> = environmentCredentials,
) {
  const binding = v.parse(activation, options);
  const table = sql`${sql.identifier(binding.metadataNamespace)}.${sql.identifier("deployment_activations")}`;
  function databaseAddress(value: string | undefined): URL | undefined {
    if (!value) return undefined;
    const address = URL.parse(value);
    if (!address || !["postgres:", "postgresql:"].includes(address.protocol)) return undefined;
    const hostname = address.hostname.replace(/-pooler\./, ".");
    if (hostname !== binding.endpointHost || decodeURIComponent(address.pathname.slice(1)) !== binding.databaseName)
      return undefined;
    if (
      ["host", "hostaddr", "port", "user", "password", "database", "dbname", "options", "connectionString"].some(
        (key) => address.searchParams.has(key),
      )
    )
      return undefined;
    return address;
  }
  return async (signal: AbortSignal, database?: ActivationDatabase): Promise<void> => {
    signal.throwIfAborted();
    try {
      const { token, branchName, connectionString } = credentials();
      const observed = databaseAddress(connectionString);
      const connected = database ? databaseAddress(database.connectionString) : undefined;
      if (
        branchName !== binding.branchName ||
        !observed ||
        !token ||
        !/^[a-f0-9]{64}$/.test(token) ||
        (database && (!connected || (observed.port || "5432") !== (connected.port || "5432")))
      )
        throw new Error("Activation refused");
      if (database) {
        if (
          database.deployment !== binding.deployment ||
          database.version !== binding.version ||
          database.metadataNamespace !== binding.metadataNamespace
        )
          throw new Error("Activation refused");
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const result = await database.db.execute<{ active: boolean }>(sql`
          SELECT true AS active FROM ${table}
          WHERE deployment = ${binding.deployment} AND version = ${binding.version}
            AND project_id = ${binding.projectId} AND branch_id = ${binding.branchId}
            AND endpoint_host = ${binding.endpointHost} AND database_name = ${binding.databaseName}
            AND token_hash = ${tokenHash} AND state IN (${sql.join(
              states.map((state) => sql`${state}`),
              sql`, `,
            )})
        `);
        if (result.rows.length !== 1 || result.rows[0]?.active !== true) throw new Error("Activation refused");
      }
    } catch {
      throw new Error("Runtime activation denied");
    }
    signal.throwIfAborted();
  };
}
