import { NeonCredentialError } from "../../neon/credentials";
import { createKelloNeonApi, createKelloNeonClient } from "../../neon/api";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { NeonApi } from "@neon/config-runtime/v1";
import * as v from "valibot";
import { resolveProjectPath } from "../../config/paths";
import { writeReceiptFile } from "../receipt-file";

export type NeonBranchProvisionProvider = Pick<NeonApi, "getProject" | "listBranches" | "listEndpoints"> & {
  createBranch(
    projectId: string,
    options: {
      name: string;
      parentId: string;
      protected: boolean;
      initSource?: "parent-data" | "schema-only";
    },
  ): Promise<{ branch: { id: string } }>;
};
const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/));
export const branchProvisionOptionsValidator = v.strictObject({
  key: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  projectId: identifier,
  parentBranchId: identifier,
  branchName: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,127}$/)),
  environment: v.picklist(["development", "preview", "production"]),
  initSource: v.optional(v.picklist(["parent-data", "schema-only"])),
});
export type NeonBranchProvisionOptions = v.InferInput<typeof branchProvisionOptionsValidator> & {
  readonly signal?: AbortSignal;
};
const branchValidator = v.object({
  id: identifier,
  name: v.string(),
  parentId: v.optional(identifier),
  protected: v.boolean(),
  isDefault: v.boolean(),
});
const common = { format: v.literal(1), identity: branchProvisionOptionsValidator, postgresVersion: v.literal(18) };
const rejectedStatus = v.picklist([400, 401, 403, 404, 409, 412, 422, 429]);
const receiptValidator = v.variant("state", [
  v.strictObject({ ...common, state: v.literal("submitting") }),
  v.strictObject({ ...common, state: v.literal("rejected"), status: rejectedStatus }),
  v.strictObject({ ...common, state: v.literal("created"), branchId: identifier }),
  v.strictObject({ ...common, state: v.literal("complete"), branchId: identifier, endpointId: identifier }),
]);
export type NeonBranchProvisionReceipt = v.InferOutput<typeof receiptValidator>;

async function inspectProvisionParent(
  options: v.InferOutput<typeof branchProvisionOptionsValidator>,
  api: NeonBranchProvisionProvider,
) {
  const observed = await Promise.all([api.getProject(options.projectId), api.listBranches(options.projectId)]).catch(
    (cause) => {
      if (cause instanceof NeonCredentialError) throw cause;
      throw new Error("Could not inspect branch provisioning target");
    },
  );
  const parsed = v.safeParse(
    v.tuple([v.object({ id: identifier, pgVersion: v.number() }), v.array(branchValidator)]),
    observed,
  );
  if (!parsed.success) throw new Error("Invalid branch provisioning target metadata");
  const [project, branches] = parsed.output;
  if (project.id !== options.projectId || project.pgVersion !== 18)
    throw new Error("Branch provisioning requires the explicit PostgreSQL 18 project");
  const parents = branches.filter((branch) => branch.id === options.parentBranchId);
  const parent = parents[0];
  if (parents.length !== 1 || !parent) throw new Error("Branch provisioning parent is absent or ambiguous");
  if (
    new Set(branches.map((branch) => branch.id)).size !== branches.length ||
    new Set(branches.map((branch) => branch.name)).size !== branches.length
  )
    throw new Error("Branch provisioning identity is ambiguous");
  return { parent, branches };
}

function providerOrDefault(provider?: NeonBranchProvisionProvider): NeonBranchProvisionProvider {
  if (provider) return provider;
  const api = createKelloNeonApi();
  const client = createKelloNeonClient();
  return {
    getProject: (projectId) => api.getProject(projectId),
    listBranches: (projectId) => api.listBranches(projectId),
    listEndpoints: (projectId) => api.listEndpoints(projectId),
    createBranch: async (projectId, options) => ({
      branch: await client.branches.create({
        projectId,
        name: options.name,
        parent_id: options.parentId,
        protected: options.protected,
        init_source: options.initSource ?? "parent-data",
      }),
    }),
  };
}

function initialization(options: v.InferOutput<typeof branchProvisionOptionsValidator>) {
  return options.initSource ?? (options.environment === "development" ? "schema-only" : "parent-data");
}

/** Plans creation only; an occupied name is never implicit adoption. */
export async function planNeonBranchProvision(
  input: NeonBranchProvisionOptions,
  provider?: NeonBranchProvisionProvider,
) {
  const { signal, ...values } = input;
  const parsed = v.safeParse(branchProvisionOptionsValidator, structuredClone(values));
  if (!parsed.success) throw new Error("Invalid branch provisioning input");
  const options = parsed.output;
  signal?.throwIfAborted();
  const { parent, branches } = await inspectProvisionParent(options, providerOrDefault(provider));
  if (branches.some((branch) => branch.name === options.branchName))
    throw new Error("Branch provisioning name is occupied");
  signal?.throwIfAborted();
  return {
    dryRun: true as const,
    action: "create" as const,
    projectId: options.projectId,
    parentBranchId: parent.id,
    parentBranchName: parent.name,
    branchName: options.branchName,
    environment: options.environment,
    initSource: initialization(options),
    protected: options.environment === "production",
    postgresVersion: 18 as const,
  };
}

/** Creates branch infrastructure only. Database quarantine and release activation remain separate stages. */
export async function provisionNeonBranch(
  root: string,
  input: NeonBranchProvisionOptions,
  provider?: NeonBranchProvisionProvider,
) {
  const { signal, ...values } = input;
  const parsed = v.safeParse(branchProvisionOptionsValidator, structuredClone(values));
  if (!parsed.success) throw new Error("Invalid branch provisioning input");
  const options = parsed.output;
  signal?.throwIfAborted();
  const api = providerOrDefault(provider);
  const directory = await resolveProjectPath(root, `.loom/provision/${options.key}`);
  await mkdir(directory, { recursive: true });
  const lock = join(directory, "branch.lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error("Branch provisioning receipt is locked");
  }
  try {
    const receiptPath = await resolveProjectPath(root, `.loom/provision/${options.key}/branch.json`);
    let receipt: NeonBranchProvisionReceipt | undefined;
    try {
      receipt = v.parse(receiptValidator, JSON.parse(await readFile(receiptPath, "utf8")));
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT")
        throw new Error("Could not read branch provisioning receipt");
    }
    if (receipt && JSON.stringify(receipt.identity) !== JSON.stringify(options))
      throw new Error("Branch provisioning receipt identity changed");
    if (receipt?.state === "submitting")
      throw new Error("Branch creation is uncertain; reconcile the provider acknowledgement before retrying");
    async function save(next: NeonBranchProvisionReceipt) {
      try {
        await writeReceiptFile(directory, "branch.json", JSON.stringify(next, null, 2) + "\n");
      } catch {
        throw new Error("Branch provisioning receipt write is uncertain");
      }
    }
    if (!receipt || receipt.state === "rejected") {
      await planNeonBranchProvision(signal ? { ...options, signal } : options, api);
      signal?.throwIfAborted();
      await save({ format: 1, identity: options, postgresVersion: 18, state: "submitting" });
      // Once submission is recorded, await the mutation and save its ID even if cancellation arrives.
      let branchId: string;
      try {
        const created = v.parse(
          v.object({ branch: v.object({ id: identifier }) }),
          await api.createBranch(options.projectId, {
            name: options.branchName,
            parentId: options.parentBranchId,
            protected: options.environment === "production",
            initSource: initialization(options),
          }),
        );
        branchId = created.branch.id;
      } catch (cause) {
        const rejection = v.safeParse(
          v.object({ kind: v.picklist(["api", "auth", "not_found", "rate_limit"]), status: rejectedStatus }),
          cause,
        );
        if (rejection.success) {
          await save({
            format: 1,
            identity: options,
            postgresVersion: 18,
            state: "rejected",
            status: rejection.output.status,
          });
          throw new Error(
            `Neon rejected branch creation (HTTP ${rejection.output.status}); repair the provider precondition before retrying`,
          );
        }
        const response = v.safeParse(v.object({ status: v.number() }), cause);
        const status = response.success ? ` (HTTP ${response.output.status})` : "";
        throw new Error(
          `Branch creation is uncertain${status}; reconcile the provider acknowledgement before retrying`,
        );
      }
      receipt = { format: 1, identity: options, postgresVersion: 18, state: "created", branchId };
      await save(receipt);
    }
    signal?.throwIfAborted();
    const acknowledged = receipt;
    async function verifyBranch() {
      const { branches } = await inspectProvisionParent(options, api);
      const branch = branches.find((entry) => entry.id === acknowledged.branchId);
      if (
        !branch ||
        branch.name !== options.branchName ||
        branch.parentId !== (initialization(options) === "schema-only" ? undefined : options.parentBranchId) ||
        branch.protected !== (options.environment === "production") ||
        branch.isDefault
      )
        throw new Error("Provisioned branch identity changed");
    }
    await verifyBranch();
    const observedEndpoints = await api.listEndpoints(options.projectId).catch((cause) => {
      if (cause instanceof NeonCredentialError) throw cause;
      throw new Error("Could not inspect provisioned branch endpoints");
    });
    const parsedEndpoints = v.safeParse(
      v.array(v.object({ id: identifier, branchId: identifier, type: v.picklist(["read_only", "read_write"]) })),
      observedEndpoints,
    );
    if (!parsedEndpoints.success) throw new Error("Invalid provisioned branch endpoint metadata");
    const selected = parsedEndpoints.output.filter(
      (entry) => entry.branchId === acknowledged.branchId && entry.type === "read_write",
    );
    const endpoint = selected[0];
    if (
      !endpoint ||
      selected.length !== 1 ||
      new Set(parsedEndpoints.output.map((entry) => entry.id)).size !== parsedEndpoints.output.length ||
      (acknowledged.state === "complete" && acknowledged.endpointId !== endpoint.id)
    )
      throw new Error("Provisioned branch endpoint is missing or changed");
    await verifyBranch();
    signal?.throwIfAborted();
    const completed = { ...acknowledged, state: "complete" as const, endpointId: endpoint.id };
    if (acknowledged.state !== "complete") await save(completed);
    signal?.throwIfAborted();
    return completed;
  } finally {
    await rm(lock, { recursive: true });
  }
}
