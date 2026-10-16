import { createHash } from "node:crypto";
import { quoteIdentifier, acquireMigrationLock } from "../../migrations/connection";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import type { NeonApi } from "@neon/config-runtime/v1";
import { createKelloNeonApi } from "../../neon/api";
import { loadProjectConfig } from "../../project/load";
import { resolveProjectPath } from "../../config/paths";
import { resolveDevelopmentCredentials } from "../../dev/connection";
import { withMigrationConnection } from "../../migrations/connection";
import { captureSchemaBaseline, establishSchemaBaselines } from "../../migrations/branch-baseline";
import { readMigrations } from "../../migrations/history";
import { writeReceiptFile } from "../receipt-file";
import { branchProvisionOptionsValidator, provisionNeonBranch } from "./provision";
import type { NeonBranchProvisionOptions, NeonBranchProvisionProvider } from "./provision";

export type SchemaProvisionProvider = NeonBranchProvisionProvider &
  Pick<NeonApi, "listBranchDatabases" | "getConnectionUri">;
const receiptValidator = v.strictObject({
  format: v.literal(1),
  state: v.picklist(["captured", "complete"]),
  fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  projectId: v.string(),
  parentBranchId: v.string(),
  namespace: v.string(),
  metadataNamespace: v.string(),
  branchId: v.optional(v.string()),
});

/** The CLI owns schema adoption; infrastructure-only callers can still use provisionNeonBranch. */
export async function provisionSchemaBranch(
  root: string,
  options: NeonBranchProvisionOptions,
  provider?: SchemaProvisionProvider,
) {
  const { signal, ...input } = options;
  v.parse(branchProvisionOptionsValidator, input);
  signal?.throwIfAborted();
  if ((options.initSource ?? (options.environment === "development" ? "schema-only" : "parent-data")) !== "schema-only")
    throw new Error("Schema adoption requires schema-only provisioning");
  const { config } = await loadProjectConfig(root);
  if (config.projectId && config.projectId !== options.projectId)
    throw new Error("Branch declaration conflicts with the linked Neon project");
  const artifacts = await readMigrations(root, config.database.migrations);
  const scope = { namespace: config.database.namespace, metadataNamespace: config.database.metadataNamespace };
  const api = provider ?? createKelloNeonApi();
  const directory = await resolveProjectPath(root, `.loom/provision/${options.key}`);
  await mkdir(directory, { recursive: true });
  const lock = join(directory, "baseline.lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error("Schema baseline receipt is locked");
  }
  try {
    let prior: v.InferOutput<typeof receiptValidator> | undefined;
    const path = await resolveProjectPath(root, `.loom/provision/${options.key}/baseline.json`);
    try {
      prior = v.parse(receiptValidator, JSON.parse(await readFile(path, "utf8")));
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
        throw new Error("Invalid schema baseline receipt");
    }
    if (
      prior &&
      (prior.projectId !== options.projectId ||
        prior.parentBranchId !== options.parentBranchId ||
        prior.namespace !== scope.namespace ||
        prior.metadataNamespace !== scope.metadataNamespace)
    )
      throw new Error("Schema baseline identity changed");
    if (prior?.state === "complete") {
      const branch = await provisionNeonBranch(root, options, provider);
      if (branch.branchId !== prior.branchId) throw new Error("Schema baseline target changed");
      return branch;
    }
    const [project, branches, endpoints, databases] = await Promise.all([
      api.getProject(options.projectId),
      api.listBranches(options.projectId),
      api.listEndpoints(options.projectId),
      api.listBranchDatabases(options.projectId, options.parentBranchId),
    ]);
    if (project.id !== options.projectId || project.pgVersion !== 18) throw new Error("Invalid schema source project");
    const parents = branches.filter((branch) => branch.id === options.parentBranchId);
    const source = parents[0];
    const writable = endpoints.filter((endpoint) => endpoint.branchId === source?.id && endpoint.type === "read_write");
    const endpoint = writable[0];
    if (!source || parents.length !== 1 || !endpoint || writable.length !== 1)
      throw new Error("Schema source branch or endpoint is ambiguous");
    const selected = config.development?.databaseName ?? config.deployment?.databaseName;
    const matches = selected ? databases.filter((database) => database.name === selected) : databases;
    const database = matches[0];
    if (!database || matches.length !== 1 || database.branchId !== source.id)
      throw new Error("Schema source database is ambiguous; link the source database explicitly");
    const sourceTarget = {
      projectId: project.id,
      branchId: source.id,
      branchName: source.name,
      endpointId: endpoint.id,
      postgresVersion: 18 as const,
    };
    const credentials = await resolveDevelopmentCredentials(api, sourceTarget, database.name, database.ownerName);
    return await withMigrationConnection(credentials.connectionString, async (sourceClient) => {
      const identity = await sourceClient.query<{ id: string }>("SELECT current_setting('neon.branch_id', true) AS id");
      if (identity.rows[0]?.id !== source.id) throw new Error("Schema source database identity differs");
      await acquireMigrationLock(sourceClient, "loom:component-ownership");
      const metadata = quoteIdentifier(scope.metadataNamespace);
      const ledger = await sourceClient.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [
        `${metadata}.component_namespaces`,
      ]);
      const ownership = ledger.rows[0]?.present
        ? (
            await sourceClient.query<{ mount_path: string; namespace: string; state: string }>(
              `SELECT mount_path,namespace,state FROM ${metadata}.component_namespaces ORDER BY mount_path`,
            )
          ).rows
        : [];
      const histories = [
        { scope, artifacts },
        ...(await Promise.all(
          ownership.map(async (row) => ({
            scope: { namespace: row.namespace, metadataNamespace: scope.metadataNamespace },
            artifacts: await readMigrations(root, join(config.database.migrations, "components", row.namespace)),
          })),
        )),
      ].sort((a, b) => a.scope.namespace.localeCompare(b.scope.namespace));
      for (const entry of histories)
        await acquireMigrationLock(sourceClient, `loom:migrations:${entry.scope.namespace}`);
      const baselines: {
        baseline: Awaited<ReturnType<typeof captureSchemaBaseline>>;
        artifacts: Awaited<ReturnType<typeof readMigrations>>;
      }[] = [];
      for (const entry of histories)
        baselines.push({
          baseline: await captureSchemaBaseline(sourceClient, entry.scope, entry.artifacts),
          artifacts: entry.artifacts,
        });
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ scopes: baselines.map((entry) => entry.baseline.fingerprint), ownership }))
        .digest("hex");
      if (prior && prior.fingerprint !== fingerprint)
        throw new Error("Source schema changed after capture; reconcile the owned branch before retrying");
      const captured = {
        format: 1 as const,
        state: "captured" as const,
        fingerprint,
        projectId: project.id,
        parentBranchId: source.id,
        ...scope,
      };
      if (!prior) await writeReceiptFile(directory, "baseline.json", JSON.stringify(captured, null, 2) + "\n");
      options.signal?.throwIfAborted();
      const receipt = await provisionNeonBranch(root, options, provider);
      const target = {
        ...sourceTarget,
        branchId: receipt.branchId,
        branchName: options.branchName,
        endpointId: receipt.endpointId,
      };
      const targetCredentials = await resolveDevelopmentCredentials(api, target, database.name, database.ownerName);
      await withMigrationConnection(targetCredentials.connectionString, async (targetClient) => {
        const observed = await targetClient.query<{ id: string }>(
          "SELECT current_setting('neon.branch_id', true) AS id",
        );
        if (observed.rows[0]?.id !== receipt.branchId || receipt.branchId === source.id)
          throw new Error("Schema target database identity differs");
        options.signal?.throwIfAborted();
        await establishSchemaBaselines(sourceClient, targetClient, baselines, ownership);
      });
      await writeReceiptFile(
        directory,
        "baseline.json",
        JSON.stringify({ ...captured, state: "complete", branchId: receipt.branchId }, null, 2) + "\n",
      );
      return receipt;
    });
  } finally {
    await rm(lock, { recursive: true });
  }
}
