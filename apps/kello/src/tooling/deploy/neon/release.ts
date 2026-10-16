import { inspectComponentReleaseScopes } from "../component-scopes";
import { migrationStatusOnConnection } from "../../migrations/status";
import { createKelloNeonApi } from "../../neon/api";
import { withProcedureUpgrade } from "../../migrations/procedure-upgrade";
import type { NeonApi } from "@neon/config-runtime/v1";
import { assertGeneratedVersion } from "../../codegen/generate";
import { loadProject } from "../../project/load";
import { inspectNeonFunctionHealth } from "./health";
import { inspectReleaseDatabase } from "./live-schema";
import { withNeonReleasePreparation } from "./prepare-release";
import type { NeonReleasePreparationOptions } from "./prepare-release";
import type { NeonReleaseReceipt } from "./release-receipt";
import { inspectRuntimeDatabase } from "./runtime-database";
import { handoffNeonIngress } from "./ingress";
import { activateNeonTriggers } from "./triggers";

/** Deploys to an explicitly selected, provisioned branch; retries verify live state before continuing. */
export async function deployNeonRelease(
  root: string,
  input: NeonReleasePreparationOptions,
  provider?: NeonApi,
): Promise<NeonReleaseReceipt> {
  const { signal = new AbortController().signal, ...values } = input;
  const options = { ...structuredClone(values), signal };
  signal.throwIfAborted();
  const project = await loadProject(root);
  if (project.version !== options.version) throw new Error("Release source version changed");
  const connectionString = options.variables[project.config.database.runtimeUrlEnv];
  if (!connectionString) throw new Error("Missing release runtime connection");
  const api = provider ?? createKelloNeonApi();
  return withNeonReleasePreparation(
    project.root,
    options,
    async ({ client, database, activation, journal }) => {
      const receipt = journal.read();
      const functions = receipt.completed.find((entry) => entry.stage === "functions");
      const bootstrap = receipt.completed.find((entry) => entry.stage === "bootstrap");
      const triggers = receipt.completed.find((entry) => entry.stage === "triggers");
      if (!functions || !triggers) throw new Error("Release preparation is incomplete");
      // Repeat health even after a saved acknowledgement: a prior observation is not current runtime evidence.
      const health = await inspectNeonFunctionHealth(
        project.root,
        {
          config: project.config,
          environment: options.environment,
          artifactHash: functions.artifactHash,
          previousArtifactHash:
            bootstrap?.artifactHash !== functions.artifactHash ? bootstrap?.artifactHash : undefined,
          activationToken: options.activationToken,
          signal,
        },
        api,
      );
      if (
        health.version !== receipt.identity.version ||
        JSON.stringify(health.target) !== JSON.stringify(receipt.identity.target) ||
        health.functions.some(
          (fn, index) =>
            fn.role !== functions.functions[index]?.role ||
            fn.functionId !== functions.functions[index]?.functionId ||
            fn.deploymentId !== functions.functions[index]?.deploymentId,
        )
      )
        throw new Error("Release health identity differs from its acknowledgement");
      await inspectReleaseDatabase(client, project.root, {
        namespace: database.namespace,
        migrations: project.config.database.migrations,
        migrationHashes: receipt.identity.migrationHashes,
        schema: receipt.identity.schema,
      });
      for (const scope of await inspectComponentReleaseScopes(project, options.componentScopes ?? [])) {
        const observed = await migrationStatusOnConnection(client, {
          root: project.root,
          namespace: scope.namespace,
          metadataNamespace: database.metadataNamespace,
          migrations: scope.migrations,
        });
        if (!observed.consistent || observed.pending.length || observed.head !== scope.inspection.head)
          throw new Error("Component scope changed before runtime activation");
        await inspectRuntimeDatabase({
          connectionString,
          database: database.database,
          namespace: scope.namespace,
          metadataNamespace: database.metadataNamespace,
          runtimeRole: options.runtimeRole,
          signal,
        });
      }
      await inspectRuntimeDatabase({
        connectionString,
        database: database.database,
        namespace: database.namespace,
        metadataNamespace: database.metadataNamespace,
        runtimeRole: options.runtimeRole,
        signal,
      });
      await assertGeneratedVersion(project.root, options.version);
      await journal.complete({ stage: "health" });
      const upgrade = {
        metadataNamespace: database.metadataNamespace,
        deployment: options.deployment,
        version: options.version,
        protocol: project.protocol,
        procedures: project.procedures.map((entry) => ({
          path: entry.path,
          visibility: entry.visibility,
          procedure: entry.definition,
        })),
        migrations: project.jobMigrations,
      };
      await withProcedureUpgrade(client, { ...upgrade, dryRun: true }, async () => {});
      await handoffNeonIngress(
        client,
        {
          deployment: options.deployment,
          releaseKey: options.releaseKey,
          version: options.version,
          config: project.config,
          environment: options.environment,
          workerSlug: options.slugs.worker,
        },
        api,
      );
      let activated = false;
      const worker = functions.functions[1];
      const enabled = await activateNeonTriggers(
        {
          config: project.config,
          environment: options.environment,
          target: database.target,
          workerSlug: worker.slug,
          workerFunctionId: worker.functionId,
          workerDeploymentId: worker.deploymentId,
          triggers: triggers.triggers,
          signal,
          assertActive: async (stageSignal) => {
            // This callback runs after provider target, worker, bucket and trigger checks, before any enable write.
            if (!activated) {
              stageSignal.throwIfAborted();
              if (receipt.completed.some((entry) => entry.stage === "activated"))
                await activation.assertActive(stageSignal);
              else await withProcedureUpgrade(client, upgrade, () => activation.activate());
              await journal.complete({ stage: "activated" });
              activated = true;
            }
            await activation.assertActive(stageSignal);
          },
        },
        api,
      );
      signal.throwIfAborted();
      await journal.complete({
        stage: "complete",
        enabledTriggerIds: enabled.triggers.map((entry) => entry.triggerId),
      });
      return journal.read();
    },
    api,
  );
}
