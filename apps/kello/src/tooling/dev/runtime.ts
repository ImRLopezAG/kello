import { projectMigrationScopes } from "../migrations/component-scopes";
import { withProcedureUpgrade } from "../migrations/procedure-upgrade";
import { createHash } from "node:crypto";
import * as v from "valibot";
import { createRpcRuntime } from "kello/server";
import type { RuntimeStorageBackend } from "kello/server";
import {
  createDevelopmentActivationVerifier,
  createDevelopmentPreparationVerifier,
  createNeonStorageBackend,
} from "kello/neon";
import { loadProject } from "../project/load";
import { projectRuntimeGraph } from "../project/runtime-graph";
import { assertGeneratedVersion } from "../codegen/generate";
import { acquireMigrationLock, databaseIdentifier } from "../migrations/connection";
import { readMigrations } from "../migrations/history";
import { inspectHistory } from "../migrations/state";
import { catalogFingerprint } from "../migrations/drift";
import { inspectRuntimeDatabase } from "../deploy/neon/runtime-database";
import { readStorageBuckets } from "../deploy/neon/storage";
import { prepareGrant, activateGrant } from "../deploy/neon/activation";
import { withDevelopmentConnection, resolveDevelopmentCredentials } from "./connection";
import type { DevelopmentDatabaseProvider } from "./connection";
import { createDevelopmentProvider, inspectDevelopmentTarget } from "./target";
import { readDevelopmentHistory } from "./history";
import type { DevelopmentSyncOptions } from "./sync";
import { provisionSearchCursorKey } from "../deploy/neon/search-key";
import { searchContractDescriptor } from "../../core/search/metadata";

export interface DevelopmentRuntimeOptions extends DevelopmentSyncOptions {
  readonly deployment: string;
  /** Keep this secret stable across generations and restarts; only its hash is stored in the database. */
  readonly activationToken: string;
  readonly storageBackend?: RuntimeStorageBackend;
}
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const developmentRuntimeOptions = v.strictObject({
  root: v.pipe(v.string(), v.minLength(1)),
  sourceVersion: hash,
  databaseName: databaseIdentifier,
  migrationRole: databaseIdentifier,
  runtimeRole: databaseIdentifier,
  deployment: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  activationToken: hash,
});

/** Starts one synchronized candidate. The caller owns runtime.stop(); no listener, watcher or schema rollback is started. */
export async function startDevelopmentRuntime(
  input: DevelopmentRuntimeOptions,
  provider?: DevelopmentDatabaseProvider,
) {
  const { signal, storageBackend, ...values } = input;
  const parsed = v.safeParse(developmentRuntimeOptions, values);
  if (!parsed.success) throw new Error("Invalid development runtime options");
  const options = parsed.output;
  const cancellation: Partial<Record<"signal", AbortSignal>> = {};
  if (signal) cancellation.signal = signal;
  const storage: Partial<Record<"storageBackend", RuntimeStorageBackend>> = {};
  if (storageBackend) storage.storageBackend = Object.freeze({ ...storageBackend });
  signal?.throwIfAborted();
  const project = await loadProject(options.root);
  if (project.version !== options.sourceVersion) throw new Error("Development candidate is stale");
  const graph = projectRuntimeGraph(project);
  const api = provider ?? createDevelopmentProvider();
  let runtime: Awaited<ReturnType<typeof createRpcRuntime>> | undefined;
  try {
    const result = await withDevelopmentConnection(
      {
        config: project.config,
        databaseName: options.databaseName,
        migrationRole: options.migrationRole,
        ...cancellation,
      },
      async (client, target, database) => {
        const { metadataNamespace } = project.config.database;
        const owner = await client.query<{ owned: boolean }>(
          "SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned FROM pg_namespace WHERE nspname = $1",
          [metadataNamespace],
        );
        if (owner.rows[0]?.owned !== true) throw new Error("Activation requires the metadata owner");
        const migrationScopes = projectMigrationScopes(project);
        await acquireMigrationLock(client, "loom:component-ownership");
        for (const scope of migrationScopes) await acquireMigrationLock(client, `loom:migrations:${scope.namespace}`);
        const applicationScope = migrationScopes.find((scope) => scope.mountPath === "");
        if (!applicationScope) throw new Error("Missing application migration scope");
        const applicationNamespace = applicationScope.namespace;
        const artifacts = await readMigrations(options.root, applicationScope.migrations);
        const { framework } = await inspectHistory(
          client,
          { namespace: applicationNamespace, metadataNamespace },
          artifacts,
        );
        if (framework.state === "diverged") throw new Error("Framework migration history is inconsistent");
        if (framework.state !== "current")
          throw new Error("Development synchronization is required before runtime startup");
        for (const scope of migrationScopes) {
          const history = await readDevelopmentHistory(client, metadataNamespace, scope.namespace, target);
          const latest = history.at(-1);
          if (!latest || latest.source_version !== options.sourceVersion)
            throw new Error("Development candidate is not synchronized");
          if (latest.after_catalog_hash !== (await catalogFingerprint(client, scope.namespace)))
            throw new Error("Live development database drift detected");
        }
        if (
          storage.storageBackend &&
          (storage.storageBackend.projectId !== target.projectId || storage.storageBackend.branchId !== target.branchId)
        )
          throw new Error("Development storage belongs to a different target");
        const names = project.storageBuckets;
        if (names.length) {
          storage.storageBackend ??= createNeonStorageBackend({
            projectId: target.projectId,
            branchId: target.branchId,
          });
          try {
            if (!storage.storageBackend || !api.listBranchBuckets) throw new Error("Storage unavailable");
            const buckets = await readStorageBuckets({ listBranchBuckets: api.listBranchBuckets.bind(api) }, target);
            if (names.some((name) => buckets.get(name)?.accessLevel !== "private"))
              throw new Error("Private bucket required");
          } catch {
            throw new Error("Could not verify development storage buckets");
          }
        }
        const credentials = await resolveDevelopmentCredentials(api, target, options.databaseName, options.runtimeRole);
        if (credentials.database.endpointHost !== database.endpointHost || credentials.database.port !== database.port)
          throw new Error("Runtime connection does not match the development database");
        for (const scope of migrationScopes)
          await inspectRuntimeDatabase({
            connectionString: credentials.connectionString,
            runtimeRole: options.runtimeRole,
            namespace: scope.namespace,
            metadataNamespace,
            database: { endpointHost: database.endpointHost, databaseName: database.databaseName },
            ...cancellation,
          });
        const current = await inspectDevelopmentTarget(project.config, api);
        if (
          (["projectId", "branchId", "branchName", "endpointId"] as const).some((key) => current[key] !== target[key])
        )
          throw new Error("Development target changed before activation");
        const binding = Object.freeze({
          metadataNamespace,
          deployment: options.deployment,
          version: options.sourceVersion,
          projectId: target.projectId,
          branchId: target.branchId,
          branchName: target.branchName,
          endpointHost: database.endpointHost,
          databaseName: database.databaseName,
        });
        const assertActive = createDevelopmentActivationVerifier(binding, {
          connectionString: credentials.connectionString,
          activationToken: options.activationToken,
        });
        await assertGeneratedVersion(options.root, options.sourceVersion);
        signal?.throwIfAborted();
        const tokenHash = createHash("sha256").update(options.activationToken).digest("hex");
        await prepareGrant(client, binding, tokenHash, signal);
        signal?.throwIfAborted();
        const assertPrepared = createDevelopmentPreparationVerifier(binding, {
          connectionString: credentials.connectionString,
          activationToken: options.activationToken,
        });
        let assembling = true;
        const cursorEnvironment = graph.procedures.some((entry) => searchContractDescriptor(entry.procedure))
          ? {
              LOOM_SEARCH_CURSOR_KEY: await provisionSearchCursorKey(client, {
                metadataNamespace,
                projectId: target.projectId,
                branchId: target.branchId,
              }),
            }
          : {};
        const common = {
          application: project.application,
          schema: project.schema,
          relations: project.relations,
          connectionString: credentials.connectionString,
          version: project.version,
          deployment: options.deployment,
          metadataNamespace,
          config: project.config,
          environment: { ...process.env, ...cursorEnvironment },
          branchId: target.branchId,
          ...storage,
          // An unpublished candidate may assemble under its quarantined grant.
          // Every operation after assembly requires active authority.
          assertActive: (...args: Parameters<typeof assertActive>) =>
            (assembling ? assertPrepared : assertActive)(...args),
        };
        runtime = await createRpcRuntime({
          ...common,
          auth: project.auth,
          storage: project.storage,
          crons: project.authoredCrons,
          jobMigrations: project.jobMigrations,
          directConnectionString: credentials.connectionString,
          ...graph,
        });
        assembling = false;
        await assertGeneratedVersion(options.root, options.sourceVersion);
        signal?.throwIfAborted();
        await withProcedureUpgrade(
          client,
          {
            metadataNamespace,
            deployment: options.deployment,
            version: project.version,
            protocol: project.protocol,
            procedures: graph.procedures,
            migrations: project.jobMigrations,
          },
          () => activateGrant(client, binding, tokenHash, signal),
        );
        const cronSchedules = Object.freeze(
          Object.fromEntries([
            ...Object.entries(project.crons).map(([name, definition]) => [name, definition.schedule]),
            ...project.componentScopes.flatMap((scope) =>
              Object.entries(scope.crons).map(([name, definition]) => [
                `${scope.schema.metadata.namespace}-${name}`,
                definition.schedule,
              ]),
            ),
          ]),
        );
        return Object.freeze({ runtime, binding, target, cronSchedules });
      },
      api,
    );
    signal?.throwIfAborted();
    return result;
  } catch (cause) {
    await runtime?.stop();
    throw cause;
  }
}
