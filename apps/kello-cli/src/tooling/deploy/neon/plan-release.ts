import { releaseHistoryNeedsRecovery } from "./history-readiness";
import { inspectComponentReleaseScopes } from "../component-scopes";
import { createKelloNeonApi } from "../../neon/api";
import type { NeonApi } from "@neon/config-runtime/v1";
import { storageUploadPrefix } from "kello/server";
import * as v from "valibot";
import { assertGeneratedVersion } from "../../codegen/generate";
import { createSnapshot, snapshotHash } from "../../migrations/adapter";
import { quoteIdentifier } from "../../migrations/connection";
import { migrationStatusOnConnection } from "../../migrations/status";
import type { MigrationStatus } from "../../migrations/status";
import { assertRuntimeCompatibility, RuntimeCompatibilityError } from "../../migrations/runtime-compatibility";
import { inspectReleaseSchema } from "../compatibility";
import { withDeploymentConnection } from "./connection";
import { prepareNeonEntrypoints } from "./entrypoints";
import { planNeonFunctions } from "./plan";
import { readProjectRelease } from "./project";
import { readNeonReleaseReceipt } from "./release-receipt";
import { assertReleaseIngress, retainedWorkerSlugs, SupersededReleaseError } from "./ingress";
import { inspectFunctionOwnership, FunctionOwnershipError } from "./function-ownership";
import { releaseResources } from "./resources";
import { readStorageBuckets } from "./storage";
import { inspectDeploymentTarget } from "./target";
import { matchesPreparedTrigger, triggerValidator } from "./triggers";
import { inspectRetainedRelease } from "./retained-release";

interface Blocker {
  readonly code:
    | "DATABASE_INCONSISTENT"
    | "FRAMEWORK_UPGRADE_REQUIRED"
    | "INCOMPATIBLE_RUNTIME"
    | "REVIEW_REQUIRED"
    | "NONTRANSACTIONAL_MIGRATION"
    | "RECEIPT_IDENTITY_CHANGED"
    | "FUNCTION_IDENTITY_CHANGED"
    | "FUNCTION_NAMES_RESERVED"
    | "RELEASE_SUPERSEDED"
    | "RETAINED_RUNTIME_INACTIVE"
    | "RUNTIME_RETIRED"
    | "PRIVATE_BUCKET_REQUIRED"
    | "TRIGGER_CONFLICT"
    | "ACTIVE_BRANCH_QUARANTINE"
    | "QUARANTINE_REQUIRED";
  readonly resource: string;
}
const functionValidator = v.object({
  id: v.string(),
  slug: v.string(),
  activeDeploymentId: v.nullish(v.number()),
  currentDeployment: v.nullish(v.object({ id: v.number(), status: v.string() })),
});

// Version 25 added component_namespaces/runtime_scopes, the last prerequisites
// consumed by these existing metadata readers. This does not permit future-column reads.
const releaseObservationFrameworkVersion = 25;

function canInspectReleaseMetadata(status: MigrationStatus): boolean {
  return (
    status.initialized &&
    (status.consistent ||
      (status.framework.state === "upgrade-required" &&
        status.framework.appliedVersion >= releaseObservationFrameworkVersion &&
        !releaseHistoryNeedsRecovery(status, false)))
  );
}

/** Read-only database/provider observations. Local generation is allowed; no secrets, health probes or receipts are written. */
export async function planProjectRelease(root: string, file: string, provider?: NeonApi, signal?: AbortSignal) {
  const { project, declaration: options } = await readProjectRelease(root, file, signal);
  if (
    options.retainedReleaseKey &&
    (options.quarantine !== "preserve" || options.retainedReleaseKey === options.releaseKey)
  )
    throw new Error("Retained code requires a new release key and preserve mode");
  if (options.environment === "production" && options.quarantine === "clone")
    throw new Error("Production release cannot quarantine work");
  const sourceSchema = snapshotHash(await createSnapshot(project.schema));
  const { namespace, metadataNamespace, migrations } = project.config.database;
  const schemaOptions = { namespace, migrations, schema: options.schema, migrationHashes: options.migrationHashes };
  const componentScopes = await inspectComponentReleaseScopes(project, options.componentScopes);
  const schema = await inspectReleaseSchema(project.root, schemaOptions);
  if (!schema.schemas.includes(sourceSchema)) throw new Error("Release schema range excludes project source");
  const resources = releaseResources(project, options.slugs.worker);
  const api = provider ?? createKelloNeonApi();
  const connection = {
    config: project.config,
    environment: options.environment,
    databaseName: options.databaseName,
    migrationRole: options.migrationRole,
  };
  return withDeploymentConnection(
    signal ? { ...connection, signal } : connection,
    async (client, target, database) => {
      // The owner connection remains read-only even outside the status helper's explicit transaction.
      await client.query("SET default_transaction_read_only = on");
      const status = await migrationStatusOnConnection(client, {
        root: project.root,
        namespace,
        metadataNamespace,
        migrations,
      });
      const componentStatuses = [];
      for (const scope of componentScopes) {
        const observed = await migrationStatusOnConnection(client, {
          root: project.root,
          namespace: scope.namespace,
          metadataNamespace,
          migrations: scope.migrations,
        });
        componentStatuses.push({ scope, observed });
      }
      const saved = await readNeonReleaseReceipt(project.root, options.releaseKey);
      if (options.retainedReleaseKey && status.pending.length > 0)
        throw new Error("Retained code release requires migrations already applied");
      const retained = options.retainedReleaseKey
        ? await inspectRetainedRelease(
            project.root,
            options.retainedReleaseKey,
            {
              deployment: options.deployment,
              version: options.version,
              target,
              database: { ...database, namespace, metadataNamespace },
              migrationHashes: options.migrationHashes,
            },
            options.slugs,
          )
        : undefined;
      const stages = saved?.completed.map((entry) => entry.stage) ?? [];
      const blockers: Blocker[] = [];
      const metadataObservable = canInspectReleaseMetadata(status);
      const metadataObservationsDeferred =
        status.framework.state === "upgrade-required" &&
        !releaseHistoryNeedsRecovery(status, false) &&
        !metadataObservable;
      if (metadataObservationsDeferred)
        blockers.push({ code: "FRAMEWORK_UPGRADE_REQUIRED", resource: metadataNamespace });

      for (const { scope, observed } of componentStatuses) {
        if (releaseHistoryNeedsRecovery(observed, stages.includes("metadata")))
          blockers.push({ code: "DATABASE_INCONSISTENT", resource: scope.namespace });
        for (const artifact of observed.pending) {
          if (!artifact.safety.transactional)
            blockers.push({ code: "NONTRANSACTIONAL_MIGRATION", resource: artifact.hash });
          if (!artifact.safety.automatic && !options.reviewedHashes.includes(artifact.hash))
            blockers.push({ code: "REVIEW_REQUIRED", resource: artifact.hash });
        }
        if (options.retainedReleaseKey && observed.pending.length)
          blockers.push({ code: "INCOMPATIBLE_RUNTIME", resource: scope.namespace });
        if (canInspectReleaseMetadata(observed)) {
          try {
            await assertRuntimeCompatibility(
              client,
              { namespace: scope.namespace, metadataNamespace },
              scope.inspection.migrationHashes,
              observed.applied.length,
              { deployment: options.deployment, version: options.version, inspection: scope.inspection },
            );
          } catch (cause) {
            if (!(cause instanceof RuntimeCompatibilityError)) throw cause;
            blockers.push({ code: "INCOMPATIBLE_RUNTIME", resource: scope.namespace });
          }
        }
      }
      if (metadataObservable) {
        const retired = await client.query(
          `SELECT 1 FROM ${quoteIdentifier(metadataNamespace)}.deployment_activations
            WHERE deployment=$1 AND version=$2 AND state='retired'`,
          [options.deployment, options.version],
        );
        if (retired.rowCount !== 0) blockers.push({ code: "RUNTIME_RETIRED", resource: options.version });
      }
      if (retained && !metadataObservable && !metadataObservationsDeferred)
        blockers.push({ code: "RETAINED_RUNTIME_INACTIVE", resource: options.version });
      if (retained && metadataObservable) {
        const active = await client.query(
          `SELECT 1 FROM ${quoteIdentifier(metadataNamespace)}.deployment_activations
            WHERE deployment=$1 AND version=$2 AND project_id=$3 AND branch_id=$4
              AND endpoint_host=$5 AND database_name=$6 AND state='active'`,
          [
            options.deployment,
            options.version,
            target.projectId,
            target.branchId,
            database.endpointHost,
            database.databaseName,
          ],
        );
        if (active.rowCount !== 1) blockers.push({ code: "RETAINED_RUNTIME_INACTIVE", resource: options.version });
      }
      if (metadataObservable && (options.quarantine === "preserve" || stages.includes("quarantine"))) {
        try {
          await assertRuntimeCompatibility(
            client,
            { namespace, metadataNamespace },
            schema.migrationHashes,
            status.applied.length,
            {
              deployment: options.deployment,
              version: options.version,
              inspection: schema,
            },
          );
        } catch (cause) {
          if (!(cause instanceof RuntimeCompatibilityError)) throw cause;
          blockers.push({ code: "INCOMPATIBLE_RUNTIME", resource: namespace });
        }
      }
      if (metadataObservable) {
        try {
          await assertReleaseIngress(client, options);
          await inspectFunctionOwnership(client, options);
        } catch (cause) {
          if (cause instanceof SupersededReleaseError)
            blockers.push({ code: "RELEASE_SUPERSEDED", resource: options.releaseKey });
          else if (cause instanceof FunctionOwnershipError)
            blockers.push({ code: "FUNCTION_NAMES_RESERVED", resource: options.deployment });
          else throw cause;
        }
      }
      for (const artifact of status.pending)
        if (!artifact.safety.transactional)
          blockers.push({ code: "NONTRANSACTIONAL_MIGRATION", resource: artifact.hash });
      if (releaseHistoryNeedsRecovery(status, stages.includes("metadata")))
        blockers.push({ code: "DATABASE_INCONSISTENT", resource: namespace });
      const pending = status.pending.map((entry) => {
        const reviewRequired = !entry.safety.automatic && !options.reviewedHashes.includes(entry.hash);
        if (reviewRequired) blockers.push({ code: "REVIEW_REQUIRED", resource: entry.hash });
        return { ...entry, reviewRequired };
      });
      if (
        saved &&
        (saved.identity.deployment !== options.deployment ||
          saved.identity.version !== options.version ||
          JSON.stringify(saved.identity.target) !== JSON.stringify(target) ||
          JSON.stringify(saved.identity.database) !== JSON.stringify({ ...database, namespace, metadataNamespace }) ||
          JSON.stringify(saved.identity.schema) !== JSON.stringify(options.schema) ||
          JSON.stringify(saved.identity.migrationHashes) !== JSON.stringify(options.migrationHashes))
      )
        blockers.push({ code: "RECEIPT_IDENTITY_CHANGED", resource: options.releaseKey });
      let quarantineCounts: { activeGrants: string; pendingJobs: string } | null = null;
      if (metadataObservable && !stages.includes("quarantine")) {
        const meta = quoteIdentifier(metadataNamespace);
        const observed = await client.query<{
          activeGrants: string;
          pendingJobs: string;
          activeBranch: boolean;
          foreignGrants: boolean;
          activeTarget: boolean;
        }>(
          `SELECT
        (SELECT count(*)::text FROM ${meta}.deployment_activations WHERE state = 'active') AS "activeGrants",
        (SELECT count(*)::text FROM ${meta}.jobs WHERE state IN ('pending', 'running')) AS "pendingJobs",
        EXISTS (SELECT 1 FROM ${meta}.deployment_activations WHERE state = 'active' AND project_id = $1 AND branch_id = $2) AS "activeBranch",
        EXISTS (SELECT 1 FROM ${meta}.deployment_activations WHERE state = 'active' AND (project_id <> $1 OR branch_id <> $2)) AS "foreignGrants",
        EXISTS (SELECT 1 FROM ${meta}.deployment_activations WHERE state = 'active' AND project_id = $1 AND branch_id = $2 AND endpoint_host = $3 AND database_name = $4) AS "activeTarget"`,
          [target.projectId, target.branchId, database.endpointHost, database.databaseName],
        );
        const counts = observed.rows[0];
        if (!counts) throw new Error("Missing release quarantine observation");
        quarantineCounts = { activeGrants: counts.activeGrants, pendingJobs: counts.pendingJobs };
        if (options.quarantine === "clone" && counts.activeBranch)
          blockers.push({ code: "ACTIVE_BRANCH_QUARANTINE", resource: target.branchId });
        if (
          options.quarantine === "preserve" &&
          (counts.foreignGrants || (!counts.activeTarget && counts.pendingJobs !== "0"))
        )
          blockers.push({ code: "QUARANTINE_REQUIRED", resource: target.branchId });
      }
      signal?.throwIfAborted();
      const prepared = saved?.completed.find((entry) => entry.stage === "triggers") ?? retained?.triggers;
      const final = saved?.completed.find((entry) => entry.stage === "functions") ?? retained?.functions;
      const entries = await prepareNeonEntrypoints(
        project.root,
        {
          metadataNamespace,
          deployment: options.deployment,
          version: options.version,
          projectId: target.projectId,
          branchId: target.branchId,
          branchName: target.branchName,
          ...database,
        },
        prepared?.bindings ?? {},
      );
      const functionPlan = await planNeonFunctions(
        { config: project.config, environment: options.environment, entries, slugs: options.slugs },
        api,
      );
      const [remoteFunctions, remoteBuckets, triggerData] = await Promise.all([
        api.listBranchFunctions(target.projectId, target.branchId),
        readStorageBuckets(api, target),
        api.listBranchTriggers(target.projectId, target.branchId),
      ]);
      const currentFunctions = v.parse(v.array(functionValidator), remoteFunctions);
      const currentTriggers = v.parse(v.array(triggerValidator), triggerData);
      const retainedWorkers = metadataObservable
        ? await retainedWorkerSlugs(client, { deployment: options.deployment, workerSlug: options.slugs.worker })
        : [];
      const ingressHandoff = {
        retainedWorkers,
        disableTriggerIds: currentTriggers
          .filter(
            (entry) =>
              retainedWorkers.includes(entry.functionSlug) &&
              entry.name !== `loom:${entry.functionSlug}:jobs` &&
              entry.enabled,
          )
          .map((entry) => entry.triggerId),
      };
      if (
        new Set(currentTriggers.map((entry) => entry.triggerId)).size !== currentTriggers.length ||
        new Set(currentTriggers.map((entry) => entry.name)).size !== currentTriggers.length
      )
        throw new Error("Ambiguous provider triggers");
      const functions = functionPlan.functions.map((entry) => {
        const expected = (final ?? saved?.completed.find((stage) => stage.stage === "bootstrap"))?.functions.find(
          (fn) => fn.role === entry.role,
        );
        const matches = currentFunctions.filter((fn) => fn.slug === entry.slug);
        const current = matches[0];
        if (
          matches.length > 1 ||
          (expected &&
            (matches.length !== 1 ||
              current?.id !== expected.functionId ||
              entry.slug !== expected.slug ||
              (final &&
                (current.activeDeploymentId !== expected.deploymentId ||
                  current.currentDeployment?.id !== expected.deploymentId ||
                  current.currentDeployment.status !== "completed"))))
        )
          blockers.push({ code: "FUNCTION_IDENTITY_CHANGED", resource: entry.slug });
        return { ...entry, action: final ? ("verify" as const) : entry.action };
      });
      const buckets = resources.buckets.map((name) => {
        const current = remoteBuckets.get(name);
        if (current && current.accessLevel !== "private")
          blockers.push({ code: "PRIVATE_BUCKET_REQUIRED", resource: name });
        if (prepared && !current) blockers.push({ code: "PRIVATE_BUCKET_REQUIRED", resource: name });
        return { name, action: prepared || current ? ("verify" as const) : ("create" as const) };
      });
      const desired = [
        ...resources.schedules.map((entry) => ({ name: entry.name, type: "schedule" as const, cron: entry.schedule })),
        ...resources.storage.map((entry) => ({
          name: entry.name,
          type: "storage_object_created" as const,
          bucketName: entry.bucket,
          prefix: storageUploadPrefix(target.projectId, target.branchId),
        })),
      ];
      const triggers = desired.map((entry) => {
        const current = currentTriggers.find((trigger) => trigger.name === entry.name);
        const snapshot = prepared?.triggers.find((trigger) => trigger.name === entry.name);
        if (
          (current &&
            (current.functionSlug !== options.slugs.worker ||
              current.type !== entry.type ||
              (current.type === "storage_object_created" &&
                entry.type === "storage_object_created" &&
                current.bucketName !== entry.bucketName))) ||
          (prepared && (!snapshot || !current || !matchesPreparedTrigger(current, snapshot)))
        )
          blockers.push({ code: "TRIGGER_CONFLICT", resource: entry.name });
        return {
          ...entry,
          functionSlug: options.slugs.worker,
          functionPath: "/api/kello/triggers",
          triggerId: current?.triggerId ?? null,
          action: prepared ? ("verify" as const) : current ? ("prepare-disabled" as const) : ("create" as const),
          activation: current?.enabled && prepared ? ("verify" as const) : ("enable-after-health" as const),
        };
      });
      if (
        prepared &&
        currentTriggers.some(
          (entry) =>
            entry.functionSlug === options.slugs.worker &&
            entry.enabled &&
            !prepared.triggers.some((expected) => expected.triggerId === entry.triggerId),
        )
      )
        blockers.push({ code: "TRIGGER_CONFLICT", resource: options.slugs.worker });
      await assertGeneratedVersion(project.root, options.version);
      await inspectReleaseSchema(project.root, schemaOptions);
      if (
        JSON.stringify(await inspectDeploymentTarget(project.config, options.environment, api)) !==
        JSON.stringify(target)
      )
        throw new Error("Release plan target changed");
      signal?.throwIfAborted();
      return {
        dryRun: true as const,
        target,
        database,
        releaseKey: options.releaseKey,
        retainedReleaseKey: options.retainedReleaseKey ?? null,
        version: options.version,
        acknowledgedStages: stages,
        metadata:
          stages.includes("metadata") && status.framework.state !== "upgrade-required"
            ? ("verify" as const)
            : status.initialized
              ? ("bootstrap-existing" as const)
              : ("initialize" as const),
        quarantine: {
          mode: options.quarantine,
          acknowledged: stages.includes("quarantine"),
          observed: quarantineCounts,
        },
        migrations: {
          framework: status.framework,
          pending,
          issues: status.issues,
          schema,
          components: componentStatuses.map(({ scope, observed }) => ({ mountPath: scope.mountPath, ...observed })),
        },
        functions,
        ingressHandoff,
        functionPasses: {
          bootstrap: prepared ? ("skip" as const) : ("deploy-or-resume" as const),
          final: final ? ("verify" as const) : ("deploy-or-resume" as const),
        },
        buckets,
        triggers,
        disableTriggerIds:
          !retained && !stages.includes("bootstrap")
            ? currentTriggers
                .filter((entry) => entry.functionSlug === options.slugs.worker && entry.enabled)
                .map((entry) => entry.triggerId)
            : [],
        activation: stages.includes("activated") ? ("verify" as const) : ("prepare-and-activate" as const),
        blockers,
        environmentReferences: { activationTokenEnv: options.activationTokenEnv, variables: options.variables },
        checksAtApply: [
          "secret-bound receipt identity",
          "runtime credential authority",
          "function archive build",
          "live database and provider state",
          "fresh function health",
          "retained worker wake schedules and ingress handoff",
          "branch-specific activation",
        ],
      };
    },
    api,
  );
}
