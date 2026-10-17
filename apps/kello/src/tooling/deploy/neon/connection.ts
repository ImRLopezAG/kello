import { NeonCredentialError } from "../../neon/credentials";
import { createKelloNeonApi } from "../../neon/api";
import type pg from "pg";
import type { NeonApi } from "@neon/config-runtime/v1";
import * as v from "valibot";
import { configValidator } from "../../config/define-config";
import type { KelloConfig } from "../../config/define-config";
import { acquireMigrationLock, databaseIdentifier, withMigrationConnection } from "../../migrations/connection";
import { inspectDeploymentTarget } from "./target";
import type { DeploymentEnvironment, DeploymentProvider, DeploymentTarget } from "./target";

export type DeploymentDatabaseProvider = DeploymentProvider & Pick<NeonApi, "getConnectionUri">;
export interface DeploymentConnectionOptions {
  readonly config: KelloConfig;
  readonly environment: DeploymentEnvironment;
  readonly databaseName: string;
  readonly migrationRole: string;
  readonly signal?: AbortSignal;
  /** Authority pinned by the caller (development); the resolved connection must match it before any write. */
  readonly expectedTarget?: ExpectedDeploymentTarget;
}
export interface ExpectedDeploymentTarget {
  readonly projectId: string;
  readonly branchId: string;
  readonly endpointId: string;
  readonly databaseName: string;
  readonly migrationRole: string;
  readonly runtimeRole: string;
  readonly namespace: string;
  readonly metadataNamespace: string;
  readonly deployment: string;
}

export interface DeploymentDatabaseIdentity {
  readonly endpointHost: string;
  readonly databaseName: string;
}

interface DeploymentConnectionContext {
  readonly target: DeploymentTarget;
  readonly database: DeploymentDatabaseIdentity;
  readonly metadataNamespace: string;
  readonly namespace: string;
  readonly signal: AbortSignal | undefined;
}
const deploymentConnections = new WeakMap<pg.Client, DeploymentConnectionContext>();

export function deploymentConnectionContext(client: pg.Client): DeploymentConnectionContext {
  const context = deploymentConnections.get(client);
  if (!context) throw new Error("Stage requires an active owned deployment connection");
  return context;
}

function validateConnection(
  uri: string,
  target: DeploymentTarget,
  databaseName: string,
  roleName: string,
): DeploymentDatabaseIdentity {
  try {
    const address = new URL(uri);
    if (
      !(
        ["postgres:", "postgresql:"].includes(address.protocol) &&
        decodeURIComponent(address.username) === roleName &&
        decodeURIComponent(address.pathname.slice(1)) === databaseName &&
        address.hostname.split(".")[0] === target.endpointId &&
        !address.hostname.includes("-pooler.")
      )
    )
      throw new Error("Connection refused");
    for (const key of [
      "host",
      "hostaddr",
      "port",
      "user",
      "password",
      "database",
      "dbname",
      "options",
      "connectionString",
    ])
      if (address.searchParams.has(key)) throw new Error("Connection refused");
    return Object.freeze({ endpointHost: address.hostname, databaseName });
  } catch {
    throw new Error("Provider connection does not match the deployment target");
  }
}

/** Owns a dedicated deployment lock and rechecks provider identity after acquiring it. Never returns credentials. */
export async function withDeploymentConnection<T>(
  options: DeploymentConnectionOptions,
  operation: (client: pg.Client, target: DeploymentTarget, database: DeploymentDatabaseIdentity) => Promise<T>,
  provider?: DeploymentDatabaseProvider,
): Promise<T> {
  const signal = options.signal;
  const config = v.parse(configValidator, options.config);
  const databaseName = v.parse(databaseIdentifier, options.databaseName);
  const roleName = v.parse(databaseIdentifier, options.migrationRole);
  const environment = v.parse(v.picklist(["preview", "production"]), options.environment);
  const api = provider ?? createKelloNeonApi();
  signal?.throwIfAborted();
  const expected = options.expectedTarget;
  if (
    expected &&
    (expected.databaseName !== databaseName ||
      expected.migrationRole !== roleName ||
      expected.namespace !== config.database.namespace ||
      expected.metadataNamespace !== config.database.metadataNamespace)
  )
    throw new Error("Deployment target changed from the selected preview target");
  const assertExpected = (resolved: DeploymentTarget) => {
    if (expected && (["projectId", "branchId", "endpointId"] as const).some((key) => resolved[key] !== expected[key]))
      throw new Error("Deployment target changed from the selected preview target");
  };
  const target = await inspectDeploymentTarget(config, environment, api);
  assertExpected(target);
  const credentials = await api
    .getConnectionUri(target.projectId, {
      branchId: target.branchId,
      endpointId: target.endpointId,
      databaseName,
      roleName,
      pooled: false,
    })
    .catch((cause) => {
      if (cause instanceof NeonCredentialError) throw cause;
      throw new Error("Could not resolve deployment connection");
    });
  const database = validateConnection(credentials.uri, target, databaseName, roleName);
  signal?.throwIfAborted();
  return withMigrationConnection(credentials.uri, async (client) => {
    await acquireMigrationLock(client, `loom:deployment:${config.database.metadataNamespace}`, false, options.signal);
    signal?.throwIfAborted();
    const current = await inspectDeploymentTarget(config, environment, api);
    if (
      (["projectId", "branchId", "branchName", "endpointId", "protected"] as const).some(
        (key) => current[key] !== target[key],
      )
    )
      throw new Error("Deployment target changed while acquiring the lock");
    assertExpected(current);
    signal?.throwIfAborted();
    deploymentConnections.set(
      client,
      Object.freeze({
        target: current,
        database,
        namespace: config.database.namespace,
        metadataNamespace: config.database.metadataNamespace,
        signal,
      }),
    );
    try {
      return await operation(client, current, database);
    } finally {
      deploymentConnections.delete(client);
    }
  });
}
