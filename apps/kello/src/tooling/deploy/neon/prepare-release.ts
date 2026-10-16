import { createKelloNeonApi } from "../../neon/api";
import { createHmac } from "node:crypto";
import type { NeonApi } from "@neon/config-runtime/v1";
import * as v from "valibot";
import { loadProject } from "../../project/load";
import { applyNeonFunctions } from "./apply";
import { prepareNeonEntrypoints } from "./entrypoints";
import { neonInjectedVariables } from "./environment";
import { slugsValidator } from "./plan";
import { readNeonFunctionReceipt } from "./receipt";
import type { NeonFunctionReceipt } from "./receipt";
import { withNeonReleaseDatabase } from "./release-database";
import type { NeonReleaseDatabaseOptions, NeonReleaseDatabaseSession } from "./release-database";
import type { NeonReleaseStage } from "./release-receipt";
import { inspectRuntimeDatabase } from "./runtime-database";
import { prepareNeonStorageBuckets, readStorageBuckets } from "./storage";
import { inspectDeploymentTarget } from "./target";
import {
  disableNeonTriggers,
  matchesPreparedTrigger,
  prepareNeonScheduleTriggers,
  prepareNeonStorageTriggers,
  triggerValidator,
} from "./triggers";
import { reserveFunctionOwnership } from "./function-ownership";
import { releaseResources } from "./resources";
import { publishNeonTriggerBindings } from "./trigger-bindings";
import { inspectRetainedRelease } from "./retained-release";
import { provisionSearchCursorKey } from "./search-key";
import { searchContractDescriptor } from "../../../core/search/metadata";

export interface NeonReleasePreparationOptions extends Omit<NeonReleaseDatabaseOptions, "inputHash"> {
  readonly slugs: Readonly<{ service: string; worker: string }>;
  /** Include the restricted runtime URL and application secrets; the activation token is supplied separately. */
  readonly variables: Readonly<Record<string, string>>;
}
type FunctionStage = Extract<NeonReleaseStage, { stage: "bootstrap" | "functions" }>;

function completedFunction<R extends "service" | "worker">(fn: NeonFunctionReceipt["functions"][number], role: R) {
  if (fn.role !== role || fn.state !== "completed" || !fn.functionId || !fn.deploymentId)
    throw new Error("Release requires completed function receipts");
  return { role, functionId: fn.functionId, deploymentId: fn.deploymentId, slug: fn.slug };
}
function acknowledgement(stage: "bootstrap" | "functions", receipt: NeonFunctionReceipt): FunctionStage {
  return {
    stage,
    artifactHash: receipt.artifactHash,
    functions: [completedFunction(receipt.functions[0], "service"), completedFunction(receipt.functions[1], "worker")],
  };
}

/** Prepares database, functions and disabled triggers; the callback retains the locks for health and activation. */
export async function withNeonReleasePreparation<T>(
  root: string,
  input: NeonReleasePreparationOptions,
  operation: (session: NeonReleaseDatabaseSession) => Promise<T>,
  provider?: NeonApi,
): Promise<T> {
  const { signal = new AbortController().signal, ...values } = input;
  const { slugs: names, variables: environment, ...databaseOptions } = structuredClone(values);
  const parsed = v.safeParse(
    v.strictObject({
      slugs: slugsValidator,
      variables: v.record(v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/)), v.string()),
    }),
    { slugs: names, variables: environment },
  );
  if (!parsed.success) throw new Error("Invalid release function input");
  const { slugs, variables } = parsed.output;
  signal.throwIfAborted();
  const project = await loadProject(root);
  if (project.version !== databaseOptions.version) throw new Error("Release source version changed");
  const reserved = [
    ...neonInjectedVariables,
    "NEON_API_KEY",
    "LOOM_ACTIVATION_TOKEN",
    "LOOM_SEARCH_CURSOR_KEY",
    project.config.database.migrationUrlEnv,
  ];
  if (
    reserved.some((name) => Object.hasOwn(variables, name)) ||
    reserved.includes(project.config.database.runtimeUrlEnv)
  )
    throw new Error("Release environment overrides a reserved variable");
  const connectionString = variables[project.config.database.runtimeUrlEnv];
  if (!connectionString) throw new Error("Missing release runtime connection");
  const directConnectionString = variables[project.config.database.directRuntimeUrlEnv];
  if (
    project.config.realtime.mode === "notify" &&
    (!directConnectionString || new URL(directConnectionString).hostname.includes("-pooler"))
  )
    throw new Error("Notify mode requires a direct runtime connection");
  const { schedules, buckets, storage } = releaseResources(project, slugs.worker);
  const sortedVariables = Object.fromEntries(
    Object.entries(variables).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const inputHash = createHmac("sha256", databaseOptions.activationToken)
    .update(JSON.stringify({ slugs, variables: sortedVariables, schedules, storage }))
    .digest("hex");
  const api = provider ?? createKelloNeonApi();
  return withNeonReleaseDatabase(
    project.root,
    { ...databaseOptions, inputHash, signal },
    async (session) => {
      const { journal, activation, database } = session;
      await reserveFunctionOwnership(session.client, {
        deployment: databaseOptions.deployment,
        version: databaseOptions.version,
        slugs,
      });
      const context = { config: project.config, environment: databaseOptions.environment };
      const searchProcedures = [...project.procedures, ...project.componentScopes.flatMap((scope) => scope.procedures)];
      const cursorEnvironment = searchProcedures.some((entry) => searchContractDescriptor(entry.definition))
        ? {
            LOOM_SEARCH_CURSOR_KEY: await provisionSearchCursorKey(session.client, {
              metadataNamespace: database.metadataNamespace,
              projectId: database.target.projectId,
              branchId: database.target.branchId,
            }),
          }
        : {};
      const functionOptions = {
        ...context,
        slugs,
        variables: { ...variables, ...cursorEnvironment, LOOM_ACTIVATION_TOKEN: databaseOptions.activationToken },
        signal,
      };
      async function assertTarget() {
        signal.throwIfAborted();
        if (
          JSON.stringify(await inspectDeploymentTarget(project.config, databaseOptions.environment, api)) !==
          JSON.stringify(database.target)
        )
          throw new Error("Release provider target changed");
        signal.throwIfAborted();
      }
      await inspectRuntimeDatabase({
        connectionString,
        database: database.database,
        namespace: database.namespace,
        metadataNamespace: database.metadataNamespace,
        runtimeRole: databaseOptions.runtimeRole,
        signal,
      });
      if (project.config.realtime.mode === "notify" && directConnectionString)
        await inspectRuntimeDatabase({
          connectionString: directConnectionString,
          database: database.database,
          namespace: database.namespace,
          metadataNamespace: database.metadataNamespace,
          runtimeRole: databaseOptions.runtimeRole,
          signal,
        });
      let receipt = journal.read();
      if (databaseOptions.retainedReleaseKey) {
        await activation.assertActive();
        const retained = await inspectRetainedRelease(
          project.root,
          databaseOptions.retainedReleaseKey,
          receipt.identity,
          slugs,
        );
        // Check both immutable local acknowledgements before adopting any stages or touching provider code.
        for (const stage of [retained.bootstrap, retained.functions]) {
          const saved = acknowledgement(stage.stage, await readNeonFunctionReceipt(project.root, stage.artifactHash));
          if (JSON.stringify(saved) !== JSON.stringify(stage)) throw new Error("Retained function receipt changed");
        }
        await journal.complete(retained.bootstrap);
        await journal.complete(retained.triggers);
        await journal.complete(retained.functions);
        receipt = journal.read();
      }
      const final = receipt.completed.find((entry) => entry.stage === "functions");
      if ((await activation.inspect()).state === "active" && !final)
        throw new Error("Active release lacks its final function acknowledgement");
      let bootstrap = receipt.completed.find((entry) => entry.stage === "bootstrap");
      let prepared = receipt.completed.find((entry) => entry.stage === "triggers");
      if (!prepared) {
        await assertTarget();
        if (!bootstrap) await disableNeonTriggers({ ...context, workerSlugs: [slugs.worker] }, api);
        const entries = await prepareNeonEntrypoints(project.root, activation.binding, {});
        if (bootstrap) {
          const saved = acknowledgement("bootstrap", await readNeonFunctionReceipt(project.root, entries.hash));
          if (JSON.stringify(saved) !== JSON.stringify(bootstrap))
            throw new Error("Bootstrap function receipt changed");
        }
        const applied = await applyNeonFunctions(project.root, { ...functionOptions, entries }, api);
        await journal.complete(acknowledgement("bootstrap", applied.receipt));
        await assertTarget();
        await prepareNeonStorageBuckets({ ...context, buckets }, api);
        const scheduled = await prepareNeonScheduleTriggers({ ...context, workerSlug: slugs.worker, schedules }, api);
        signal.throwIfAborted();
        const stored = await prepareNeonStorageTriggers(
          { ...context, workerSlug: slugs.worker, buckets: storage },
          api,
        );
        const triggers = [...scheduled.triggers, ...stored.triggers].map(
          ({ binding: _binding, ...trigger }) => trigger,
        );
        await journal.complete({
          stage: "triggers",
          triggers,
          bindings: { ...scheduled.bindings, ...stored.bindings },
        });
        receipt = journal.read();
        prepared = receipt.completed.find((entry) => entry.stage === "triggers");
        bootstrap = receipt.completed.find((entry) => entry.stage === "bootstrap");
      }
      if (!prepared || !bootstrap) throw new Error("Missing release preparation receipt");
      const expectedTriggers = prepared.triggers;
      async function verifyTriggers() {
        await assertTarget();
        const currentBuckets = await readStorageBuckets(api, database.target);
        if (buckets.some((name) => currentBuckets.get(name)?.accessLevel !== "private"))
          throw new Error("Release private bucket changed");
        const currentTriggers = v.parse(
          v.array(triggerValidator),
          await api.listBranchTriggers(database.target.projectId, database.target.branchId),
        );
        const allowEnabled = (await activation.inspect()).state === "active";
        if (new Set(currentTriggers.map((entry) => entry.triggerId)).size !== currentTriggers.length)
          throw new Error("Release trigger identity changed");
        for (const expected of expectedTriggers) {
          const current = currentTriggers.find((entry) => entry.triggerId === expected.triggerId);
          if (!current || (!allowEnabled && current.enabled) || !matchesPreparedTrigger(current, expected))
            throw new Error("Release trigger binding changed");
        }
        if (
          currentTriggers.some(
            (entry) =>
              entry.functionSlug === slugs.worker &&
              entry.enabled &&
              !expectedTriggers.some((expected) => expected.triggerId === entry.triggerId),
          )
        )
          throw new Error("Release has an unprepared enabled trigger");
      }
      await verifyTriggers();
      await publishNeonTriggerBindings(session.client, activation.binding, prepared.bindings);
      const remote = await api.listBranchFunctions(database.target.projectId, database.target.branchId);
      for (const expected of bootstrap.functions) {
        const matches = remote.filter((entry) => entry.slug === expected.slug);
        if (matches.length !== 1 || matches[0]?.id !== expected.functionId)
          throw new Error("Release function identity changed");
      }
      const entries = await prepareNeonEntrypoints(project.root, activation.binding, prepared.bindings);
      if (final) {
        const saved = acknowledgement("functions", await readNeonFunctionReceipt(project.root, entries.hash));
        if (JSON.stringify(saved) !== JSON.stringify(final)) throw new Error("Final function receipt changed");
      }
      signal.throwIfAborted();
      const applied = await applyNeonFunctions(project.root, { ...functionOptions, entries }, api);
      await verifyTriggers();
      await journal.complete(acknowledgement("functions", applied.receipt));
      await assertTarget();
      return operation(session);
    },
    api,
  );
}
