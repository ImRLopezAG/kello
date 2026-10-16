import { createComponentStorageRuntime } from "./storage/component-runtime";
import { getBetterAuthRegistration } from "../better-auth/state";
import { sealComponentGraph } from "./components/graph";
import { neonAuthHosting } from "../adapters/neon/auth";
import type { ComponentHttpMount, ComponentHttpRoute } from "./components/http";
import type { ProjectSchema } from "./rpc/procedure";
import { Layer } from "effect";
import { prepareApplicationEnvironment } from "./application/definition";
import type { ApplicationEnvironmentDefinition } from "./application/definition";
import { createEffectRuntime } from "./effect/runtime";
import type { InvocationIdentity } from "./auth/context";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { lockRuntimeActivation } from "./activation";
import type { AnyRelations } from "drizzle-orm";
import * as v from "valibot";
import { connectDatabase } from "./database/connection";
import type { DatabaseOptions } from "./database/connection";
import { createRpcAuthentication } from "./auth/rpc-definition";
import type { RpcAuthDefinition } from "./auth/rpc-definition";
import { createConnectionTickets } from "./auth/tickets";
import type { JobMigration } from "./jobs/rpc-migrations";
import { createRpcJobQueue } from "./jobs/rpc-queue";
import { createRpcJobWorker } from "./jobs/rpc-worker";
import { createRpcCronDispatcher } from "./jobs/rpc-crons";
import { createTransactionalRpcScheduler } from "./jobs/rpc-service";
import { createDependencyRegistry } from "./realtime/dependencies";
import { createRevisionCoordinator } from "./realtime/coordinator";
import { listenForRevisions } from "./realtime/notifications";
import { bindRuntimeGraph } from "./rpc/runtime-graph";
import type { RuntimeProcedureEntry } from "./rpc/runtime-graph";
import { generateRpcOpenAPI } from "./rpc/openapi";
import { runtimeConfigValidator } from "./config";
import type { RuntimeConfigInput } from "./config";
import { validateIdempotencyOptions } from "./idempotency";
import { defineProcedureStorage, isProcedureStorage, compileProcedureCapabilities } from "./rpc/capabilities";
import type { ProcedureCron, ProcedureStorageDefinition } from "./rpc/capabilities";
import { createStorageCleanup } from "./storage/cleanup";
import { createStorageIntents } from "./storage/intents";
import { createRpcStorageEventDispatcher } from "./storage/rpc-events";

import type { RuntimeStorageBackend, ActivationDatabase } from "./runtime-contracts";
import { searchContractDescriptor } from "../search/metadata";
import { readSearchCursorKey } from "../search/cursor";

export interface RpcRuntimeOptions<Relations extends AnyRelations> extends DatabaseOptions<Relations> {
  readonly authScopes?: readonly {
    readonly mountPath: string;
    readonly namespace: string;
    readonly fingerprint: string;
  }[];
  readonly application?: ApplicationEnvironmentDefinition | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly version: string;
  readonly deployment: string;
  readonly metadataNamespace: string;
  readonly branchId?: string;
  readonly procedures: readonly RuntimeProcedureEntry[];
  readonly exposures?: readonly { readonly scope: string; readonly prefix: string }[];
  readonly scopes?: readonly {
    readonly name: string;
    readonly dependencies: Readonly<Record<string, string>>;
    readonly schema?: ProjectSchema;
    readonly crons?: Readonly<Record<string, ProcedureCron>>;
    readonly storage?: ProcedureStorageDefinition;
  }[];
  /** Internal generation rollout switch; never selected by an RPC request. */
  readonly selectiveInvalidation?: boolean;
  readonly jobMigrations?: readonly JobMigration[];
  readonly directConnectionString?: string;
  readonly config?: RuntimeConfigInput;
  readonly auth?: RpcAuthDefinition;
  readonly crons?: Readonly<Record<string, ProcedureCron>>;
  readonly storage?: ProcedureStorageDefinition;
  readonly storageBackend?: RuntimeStorageBackend;
  /** Called before connection without a database, then with the owned database at startup and every activation boundary. */
  readonly assertActive: (signal: AbortSignal, database?: ActivationDatabase) => Promise<void>;
  readonly assertIngress?: (signal: AbortSignal, database: ActivationDatabase) => Promise<void>;
}

/** Owns one generation's database and background capabilities. Never performs migrations. */
export async function createRpcRuntime<Relations extends AnyRelations>(options: RpcRuntimeOptions<Relations>) {
  const hasSearch = options.procedures.some((entry) => searchContractDescriptor(entry.procedure));
  if (hasSearch) {
    readSearchCursorKey((options.environment ?? process.env).LOOM_SEARCH_CURSOR_KEY);
    if (!options.branchId) throw new Error("Search branch binding required");
  }
  const search = hasSearch
    ? { branchId: options.branchId!, key: (options.environment ?? process.env).LOOM_SEARCH_CURSOR_KEY! }
    : undefined;
  let application = options.application
    ? await prepareApplicationEnvironment(options.application, options.environment ?? process.env)
    : undefined;
  const config = v.parse(runtimeConfigValidator, options.config ?? {});
  const auth = createRpcAuthentication(config.auth, options.auth);
  const { metadataNamespace, deployment, version } = options;
  const procedures = options.procedures.map((entry) =>
    Object.freeze({ ...entry, path: Object.freeze([...entry.path]) }),
  );
  const jobMigrations = Object.freeze([...(options.jobMigrations ?? [])]);
  const internal = procedures.filter((entry) => entry.visibility === "internal");
  const storageDefinition = options.storage ?? defineProcedureStorage();
  if (!isProcedureStorage(storageDefinition)) throw new Error("Expected defineProcedureStorage's result");
  const storageBackend = options.storageBackend ? Object.freeze({ ...options.storageBackend }) : undefined;
  const buckets = Object.keys(storageDefinition.buckets);
  const hasBuckets =
    buckets.length > 0 || (options.scopes ?? []).some((scope) => Object.keys(scope.storage?.buckets ?? {}).length > 0);
  if (hasBuckets && !storageBackend) throw new Error("Storage backend required for declared buckets");
  if (storageBackend && !hasBuckets) throw new Error("Storage backend requires declared buckets");
  const { handlers, crons: declarations } = compileProcedureCapabilities({
    version,
    internal,
    crons: options.crons ?? {},
    storage: storageDefinition,
    maxAttempts: config.jobs.maxAttempts,
  });
  const scopedCapabilities = (options.scopes ?? [])
    .filter((scope) => scope.name)
    .map((scope) => ({
      scope,
      ...compileProcedureCapabilities({
        version,
        scope: scope.name,
        internal,
        crons: scope.crons ?? {},
        storage: scope.storage ?? defineProcedureStorage(),
        maxAttempts: config.jobs.maxAttempts,
      }),
    }));
  const allCrons = { ...declarations };
  for (const { scope, crons } of scopedCapabilities) {
    for (const [name, declaration] of Object.entries(crons)) {
      if (!scope.schema) throw new Error("Missing component schema");
      const key = `${scope.schema.metadata.namespace}-${name}`;
      if (Object.hasOwn(allCrons, key)) throw new Error(`Conflicting cron identity: ${key}`);
      allCrons[key] = declaration;
    }
  }
  Object.freeze(allCrons);
  const directConnectionString = options.directConnectionString;
  if (config.realtime.mode === "notify" && !directConnectionString)
    throw new Error("Notify mode requires a direct runtime database URL");
  if (config.realtime.mode === "notify" && directConnectionString) {
    const direct = URL.parse(directConnectionString);
    const pooled = URL.parse(options.connectionString);
    if (
      !direct ||
      !pooled ||
      ["host", "hostaddr", "port", "user", "password", "database", "dbname", "options", "connectionString"].some(
        (key) => direct.searchParams.has(key) || pooled.searchParams.has(key),
      ) ||
      direct.hostname.includes("-pooler") ||
      direct.hostname !== pooled.hostname.replace("-pooler", "") ||
      (direct.port || "5432") !== (pooled.port || "5432") ||
      direct.pathname !== pooled.pathname ||
      direct.username !== pooled.username ||
      !["postgres:", "postgresql:"].includes(direct.protocol)
    )
      throw new Error("Direct runtime URL must match the runtime database and role");
  }
  const idempotency = { metadataNamespace, deployment };
  validateIdempotencyOptions(idempotency);
  const shutdown = new AbortController();
  const assertActive = options.assertActive;
  const assertIngress = options.assertIngress;
  async function ingress(signal: AbortSignal, db: NodePgDatabase): Promise<void> {
    if (!activationDatabase) throw new Error("Runtime ingress denied");
    if (assertIngress) await assertIngress(signal, { ...activationDatabase, db });
    else await activate(signal, db);
  }
  const connectionString = options.connectionString;
  let activationDatabase: ActivationDatabase | undefined;
  const effects = createEffectRuntime(Layer.empty);
  let stopped = false;
  let stopping: Promise<void> | undefined;
  async function activate(signal: AbortSignal, db?: NodePgDatabase): Promise<void> {
    signal.throwIfAborted();
    try {
      await assertActive(signal, db && activationDatabase ? { ...activationDatabase, db } : activationDatabase);
    } catch {
      throw new Error("Runtime activation denied");
    }
    signal.throwIfAborted();
  }
  function own<T, Input>(
    input: Input,
    operation: (input: Input, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    identity: InvocationIdentity | null = null,
  ): Promise<T> {
    if (stopped) return Promise.reject(new Error("Runtime stopped"));
    let captured: Input;
    try {
      captured = structuredClone(input);
    } catch (cause) {
      return Promise.reject(cause);
    }
    const current = signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal;
    return effects.promise(
      { identity, requestId: crypto.randomUUID() },
      ({ signal }) => operation(captured, signal),
      current,
    );
  }
  const dependencyRegistry = createDependencyRegistry(metadataNamespace, [
    { scope: "", schema: options.schema },
    ...(options.scopes ?? []).flatMap((scope) =>
      scope.name && scope.schema ? [{ scope: scope.name, schema: scope.schema }] : [],
    ),
  ]);
  const allRevisions = dependencyRegistry.read;
  const dependencies = {
    registry: dependencyRegistry,
    authorization: auth.dependencies,
    selective: options.selectiveInvalidation ?? true,
  };
  await activate(shutdown.signal);
  const connection = await connectDatabase({ ...options, connectionString });
  let objectStorage: ReturnType<RuntimeStorageBackend["connect"]> | undefined;
  async function close(): Promise<void> {
    try {
      try {
        await effects.stop();
      } finally {
        await objectStorage?.close();
      }
    } finally {
      await connection.close();
    }
  }
  try {
    activationDatabase = Object.freeze({ db: connection.db, connectionString, deployment, version, metadataNamespace });
    await activate(shutdown.signal);
    let authHttp: import("../adapters/neon/auth-http").AuthHttpMount[] = [];
    const nativeAuth =
      options.application &&
      sealComponentGraph(options.application)
        .nodes.map((node) => getBetterAuthRegistration(node.definition))
        .find((registration) => registration !== undefined);
    if (options.authScopes?.length || nativeAuth) {
      if (!options.application || !application) throw new Error("Auth scopes require an application");
      if (!nativeAuth) throw new Error("Planned auth scope has no mounted definition");
      const initialized = await nativeAuth.initialize({
        definition: options.application,
        application,
        scopes: options.authScopes ?? [],
        database: connection.db,
        trust: auth.trust,
        activate,
      });
      application = initialized.application;
      authHttp = initialized.mounts;
    }
    const managedAuth = neonAuthHosting(options.auth?.verification, options.environment ?? process.env);
    if (managedAuth) {
      const { createNeonAuthMount } = await import("../adapters/neon/neon-auth-http");
      authHttp.push(createNeonAuthMount({ ...managedAuth, activate }));
    }
    const queue = createRpcJobQueue({
      ...idempotency,
      db: connection.db,
      version,
      internal,
      migrations: jobMigrations,
      maxAttempts: config.jobs.maxAttempts,
      retryDelaySeconds: config.jobs.retryBaseMs / 1000,
    });
    let componentStorage: ReturnType<typeof createComponentStorageRuntime> | undefined;
    let storage:
      | {
          readonly intents: ReturnType<typeof createStorageIntents>;
          readonly cleanup: ReturnType<typeof createStorageCleanup>;
          readonly events: ReturnType<typeof createRpcStorageEventDispatcher>;
        }
      | undefined;
    if (storageBackend) {
      objectStorage = storageBackend.connect();
      const target = { projectId: storageBackend.projectId, branchId: storageBackend.branchId };
      const storageOptions = {
        ...idempotency,
        applicationNamespace: options.schema.metadata.namespace,
        ...target,
        db: connection.db,
        buckets,
        storage: objectStorage,
        assertActive: activate,
        authorize: storageDefinition.authorize,
      };
      const intents = createStorageIntents(storageOptions);
      const cleanup = createStorageCleanup(storageOptions);
      const events = createRpcStorageEventDispatcher({
        version,
        ...idempotency,
        ...target,
        db: connection.db,
        intents,
        queue,
        handlers,
        assertActive: activate,
        assertIngress: ingress,
      });
      componentStorage = createComponentStorageRuntime({
        ...storageOptions,
        version,
        queue,
        rootEvents: events,
        assertIngress: ingress,
        scopes: scopedCapabilities
          .filter(({ scope }) => Object.keys(scope.storage?.buckets ?? {}).length > 0)
          .map(({ scope, handlers }) => ({
            scope: scope.name,
            handlers,
            storage: {
              ...scope.storage!,
              authorize: (context) => {
                if (!application) throw new Error("Missing component application");
                return application.runComponent(scope.name, () => scope.storage!.authorize(context));
              },
            },
          })),
      });
      const scopedStorage = componentStorage;
      storage = Object.freeze({
        cleanup: Object.freeze<typeof cleanup>({
          run: (limit, signal) =>
            own(
              limit,
              async (input, current) => {
                const root = await cleanup.run(input, current);
                const components = await scopedStorage.cleanup(input, current);
                return { processed: root.processed + components.processed, failed: root.failed + components.failed };
              },
              signal,
            ),
        }),
        intents: Object.freeze<typeof intents>({
          create: (identity, upload, requestKey, signal) =>
            own(
              { identity, upload, requestKey },
              (input, current) => intents.create(input.identity, input.upload, input.requestKey, current),
              signal,
            ),
          status: (identity, id, signal) =>
            own({ identity, id }, (input, current) => intents.status(input.identity, input.id, current), signal),
          signUpload: (identity, id, signal) =>
            own({ identity, id }, (input, current) => intents.signUpload(input.identity, input.id, current), signal),
          finalize: (identity, id, signal) =>
            own({ identity, id }, (input, current) => intents.finalize(input.identity, input.id, current), signal),
          signDownload: (identity, id, signal) =>
            own({ identity, id }, (input, current) => intents.signDownload(input.identity, input.id, current), signal),
        }),
        events: Object.freeze<typeof events>({
          receive: (delivery, signal) =>
            own(delivery, (input, current) => scopedStorage.receive(input, current), signal),
          reconcile: (limit, signal) => own(limit, (input, current) => scopedStorage.reconcile(input, current), signal),
        }),
      });
    }
    const transaction: typeof connection.transaction = (operation, config) =>
      connection.transaction(async (tx) => {
        // LOCK precedes the first SELECT so repeatable-read admission observes any completed retirement.
        await lockRuntimeActivation(tx, metadataNamespace);
        await activate(shutdown.signal, tx);
        return operation(tx);
      }, config);
    const runtimeConnection = { ...connection, transaction };
    const scheduler = createTransactionalRpcScheduler({ version, internal, queue });
    const coordinatorOptions = {
      readRevisions: () =>
        own(undefined, async (_input, signal) => {
          await activate(signal);
          return allRevisions(connection.db);
        }),
      intervalMs: config.realtime.pollIntervalMs,
      maxSubscriptions: config.realtime.maxSubscriptions,
    };
    const coordinator = createRevisionCoordinator(
      config.realtime.mode === "notify" && directConnectionString
        ? {
            ...coordinatorOptions,
            wakeups: (wake) =>
              listenForRevisions(
                {
                  connectionString: directConnectionString,
                  runtimeRole: decodeURIComponent(new URL(connectionString).username),
                  namespace: options.schema.metadata.namespace,
                  componentNamespaces: (options.scopes ?? []).flatMap((scope) =>
                    scope.schema ? [scope.schema.metadata.namespace] : [],
                  ),
                  metadataNamespace,
                },
                wake,
              ),
          }
        : coordinatorOptions,
    );
    const scopeDatabases = new Map(
      [...new Set(["", ...(options.scopes ?? []).map((scope) => scope.name)])].map((scope) => [
        scope,
        {
          connection: runtimeConnection,
          replay: idempotency,
          scope,
          revisions: allRevisions,
          dependencies,
          scheduler: scope ? createTransactionalRpcScheduler({ version, internal, queue, scope }) : scheduler,
          maxResultBytes: config.realtime.maxResultBytes,
          authorize: auth.authorize,
          search,
        },
      ]),
    );
    const graph = bindRuntimeGraph({
      application,
      storage: storage?.intents,
      storageForScope: (scope) => componentStorage?.forScope(scope),
      entries: procedures,
      exposures: options.exposures,
      scopes: options.scopes,
      effects,
      coordinator,
      activate,
      authorize: auth.authorize,
      databaseForScope: (scope) => {
        const database = scopeDatabases.get(scope);
        if (!database) throw new Error(`Unknown database scope: ${scope}`);
        return database;
      },
      database: {
        connection: runtimeConnection,
        replay: idempotency,
        revisions: allRevisions,
        dependencies,
        scheduler,
        maxResultBytes: config.realtime.maxResultBytes,
        authorize: auth.authorize,
        search,
      },
    });
    // Reject incomplete public contracts before a candidate can be activated.
    if (config.openapi) await generateRpcOpenAPI(graph.snapshots);
    const worker = Object.freeze(
      createRpcJobWorker({
        queue,
        internal: graph.internal,
        assertActive: activate,
        leaseSeconds: config.jobs.leaseMs / 1000,
      }),
    );
    const cronDispatcher = createRpcCronDispatcher({
      ...idempotency,
      db: connection.db,
      queue,
      crons: allCrons,
      assertIngress: ingress,
      assertActive: activate,
    });
    const crons = Object.freeze<typeof cronDispatcher>({
      dispatch: (name, at, signal, delivery) =>
        own(
          { name, at, delivery },
          ({ name, at, delivery }, current) => cronDispatcher.dispatch(name, at, current, delivery),
          signal,
        ),
      recordWake: (delivery, at, signal) =>
        own({ delivery, at }, ({ delivery, at }, current) => cronDispatcher.recordWake(delivery, at, current), signal),
    });
    const connectionTickets = createConnectionTickets({
      ...idempotency,
      db: connection.db,
      namespace: options.schema.metadata.namespace,
      version,
      assertActive: (db) => activate(shutdown.signal, db),
    });
    const tickets = Object.freeze<typeof connectionTickets>({
      issue: (...args) =>
        own(args, async (args, signal) => {
          await activate(signal);
          return connectionTickets.issue(...args);
        }),
      redeem: (...args) =>
        own(args, async (args, signal) => {
          await activate(signal);
          return connectionTickets.redeem(...args);
        }),
    });
    return Object.freeze({
      authHttp,
      componentHttp: (application?.http ?? []).map((mount): ComponentHttpMount => {
        const schema = options.scopes?.find((scope) => scope.name === mount.scope)?.schema;
        if (!schema) throw new Error(`Missing HTTP component schema: ${mount.scope}`);
        return {
          prefix: `/api/components/${mount.scope}`,
          // SAFETY: generated scope metadata pairs this definition's handlers with its own validated context.
          routes: (mount.routes as readonly ComponentHttpRoute[]).map((route) => {
            const access = route.access;
            if (access.kind === "signed-webhook")
              return {
                ...route,
                access: {
                  ...access,
                  verify: (input) => application!.runComponent(mount.scope, () => access.verify(input)),
                },
              };
            if (access.kind === "verified-user")
              return {
                ...route,
                access: {
                  ...access,
                  authorize: (session, request) =>
                    application!.runComponent(mount.scope, () => access.authorize(session, request)),
                },
              };
            return route;
          }),
          invoke: (invocation, work) =>
            graph.invokeComponentHttp(mount.scope, invocation, (context) =>
              work({
                ...context,
                ...mount.context,
                tables: schema.tables,
                validators: { tables: schema.validators, id: schema.id },
              }),
            ),
        };
      }),
      auth: application?.liveQueries
        ? {
            ...auth,
            resolveLogin: application.liveQueries.resolveLogin,
            liveQueries: {
              secret: application.liveQueries.secret,
              database: application.liveQueries.database,
              deployment: application.liveQueries.deployment,
            },
          }
        : auth,
      version,
      router: graph.router,
      snapshots: graph.snapshots,
      openapi: config.openapi,
      worker,
      crons,
      tickets,
      storage,
      realtime: Object.freeze({
        coordinator,
        heartbeatMs: config.realtime.heartbeatMs,
        maxSubscriptions: config.realtime.maxSubscriptions,
        maxBufferedBytes: config.realtime.maxResultBytes,
      }),
      stop(): Promise<void> {
        if (stopping) return stopping;
        let workerStopped: Promise<void> | undefined;
        let pollerStopped: Promise<void> | undefined;
        stopping = Promise.resolve().then(async () => {
          try {
            await Promise.all([effects.stop(), graph.stop()]);
            await Promise.all([workerStopped, pollerStopped]);
          } finally {
            await close();
          }
        });
        stopped = true;
        shutdown.abort();
        workerStopped = worker.stop();
        pollerStopped = coordinator.stop();
        return stopping;
      },
    });
  } catch (cause) {
    await close();
    throw cause;
  }
}
