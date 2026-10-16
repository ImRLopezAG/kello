import { createKelloNeonApi } from "../../neon/api";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { apply, buildFunctionBundle } from "@neon/config-runtime/v1";
import type { NeonApi } from "@neon/config-runtime/v1";
import * as v from "valibot";
import { planNeonFunctions } from "./plan";
import type { NeonFunctionPlanOptions } from "./plan";
import { neonInjectedVariables } from "./environment";
import { readWithSignal } from "./observe";
import { neonFunctionPolicy } from "./policy";
import { inspectDeploymentTarget } from "./target";
import { loadFunctionReceipt, receiptDirectory, withFunctionApplyLock, writeFunctionReceipt } from "./receipt";
import type { NeonFunctionReceipt } from "./receipt";

export interface NeonFunctionApplyOptions extends NeonFunctionPlanOptions {
  readonly variables: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Bounds provider status reads. An in-flight mutation is awaited so its acknowledgement can be recorded. */
  readonly timeoutMs?: number;
}
const deploymentId = v.pipe(v.number(), v.integer(), v.minValue(1));
const deploymentValidator = v.object({
  id: deploymentId,
  status: v.picklist(["pending", "building", "completed", "failed"]),
});
const functionsValidator = v.array(
  v.object({
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    slug: v.string(),
    invocationUrl: v.string(),
    activeDeploymentId: v.optional(deploymentId),
    currentDeployment: v.optional(deploymentValidator),
  }),
);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function deploymentVariables(options: NeonFunctionApplyOptions) {
  const parsed = v.safeParse(v.record(v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/)), v.string()), options.variables);
  if (!parsed.success) throw new Error("Invalid function environment");
  const variables = parsed.output;
  const reserved = [...neonInjectedVariables, "NEON_API_KEY", options.config.database.migrationUrlEnv];
  if (
    reserved.some((name) => Object.hasOwn(variables, name)) ||
    reserved.includes(options.config.database.runtimeUrlEnv)
  )
    throw new Error("Function environment overrides a reserved credential or identity variable");
  const token = variables.LOOM_ACTIVATION_TOKEN;
  if (!v.is(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)), token)) throw new Error("Invalid function activation token");
  const connection = URL.parse(variables[options.config.database.runtimeUrlEnv] ?? "");
  const binding = options.entries.binding;
  if (
    !connection ||
    !["postgres:", "postgresql:"].includes(connection.protocol) ||
    !connection.username ||
    connection.hostname.replace(/-pooler(?=\.)/, "") !== binding.endpointHost ||
    decodeURIComponent(connection.pathname.slice(1)) !== binding.databaseName ||
    ["host", "hostaddr", "port", "user", "password", "database", "dbname", "options", "connectionString"].some((name) =>
      connection.searchParams.has(name),
    )
  )
    throw new Error("Function runtime connection does not match the activation binding");
  const sorted = Object.fromEntries(
    Object.keys(variables)
      .sort()
      .map((name) => [name, variables[name]]),
  );
  const inputHash = createHmac("sha256", token)
    .update(JSON.stringify({ binding, slugs: options.slugs, variables: sorted }))
    .digest("hex");
  // Neon merges environments. Empty values delete old overrides and restore injected identity defaults.
  return {
    inputHash,
    variables: { ...variables, ...Object.fromEntries(neonInjectedVariables.map((name) => [name, ""])) },
  };
}

async function archiveFunction(
  directory: string,
  role: "service" | "worker",
  slug: string,
  source: string,
): Promise<NeonFunctionReceipt["functions"][number]> {
  const bytes = await buildFunctionBundle({
    slug,
    name: `Kello ${role}`,
    source,
    env: {},
    runtime: "nodejs24",
    bundler: "esbuild",
  });
  const bundleHash = digest(bytes);
  const filename = join(directory, `${bundleHash}.zip`);
  const temporary = join(directory, `.bundle-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    role,
    slug,
    bundleHash,
    state: "ready",
    baselineId: null,
    deploymentId: null,
    deploymentIds: [],
    functionId: null,
    invocationUrl: null,
  };
}

/** Deploys code only. Schema expansion, grant activation and provider triggers remain separate ordered stages. */
export async function applyNeonFunctions(root: string, input: NeonFunctionApplyOptions, provider?: NeonApi) {
  const { signal, ...serializable } = input;
  const options = structuredClone(serializable);
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    throw new Error("Invalid function deployment timeout");
  const environment = deploymentVariables(options);
  signal?.throwIfAborted();
  const api = provider ?? createKelloNeonApi();
  return withFunctionApplyLock(root, async () => {
    const planned = await planNeonFunctions(options, api);
    const directory = await receiptDirectory(root, options.entries.hash);
    const [entryDirectory, serviceEntry, workerEntry] = await Promise.all([
      realpath(options.entries.directory),
      realpath(options.entries.service),
      realpath(options.entries.worker),
    ]);
    if (
      entryDirectory !== directory ||
      serviceEntry !== join(directory, "service.mjs") ||
      workerEntry !== join(directory, "worker.mjs")
    )
      throw new Error("Function entries are outside their deployment artifact directory");
    let receipt = await loadFunctionReceipt(directory);
    if (receipt) {
      if (
        receipt.inputHash !== environment.inputHash ||
        receipt.version !== planned.version ||
        receipt.artifactHash !== planned.artifactHash ||
        JSON.stringify(receipt.target) !== JSON.stringify(planned.target) ||
        receipt.functions.some(
          (fn, index) => fn.role !== planned.functions[index]?.role || fn.slug !== planned.functions[index]?.slug,
        )
      )
        throw new Error("Deployment receipt inputs changed");
    } else {
      receipt = {
        format: 1,
        target: structuredClone(planned.target),
        version: planned.version,
        artifactHash: planned.artifactHash,
        inputHash: environment.inputHash,
        functions: [
          await archiveFunction(directory, "service", options.slugs.service, options.entries.service),
          await archiveFunction(directory, "worker", options.slugs.worker, options.entries.worker),
        ],
      };
      await writeFunctionReceipt(directory, receipt);
    }
    const progress = receipt;
    const archives = new Map<string, Uint8Array>();
    for (const fn of progress.functions) {
      const bytes = await readFile(join(directory, `${fn.bundleHash}.zip`));
      if (digest(bytes) !== fn.bundleHash) throw new Error("Deployment bundle changed");
      archives.set(fn.slug, bytes);
    }
    async function assertTarget(waitSignal = signal) {
      const current = await readWithSignal(
        () => inspectDeploymentTarget(options.config, options.environment, api),
        waitSignal,
      );
      if (JSON.stringify(current) !== JSON.stringify(progress.target)) throw new Error("Deployment target changed");
    }
    async function observe(slug: string, waitSignal?: AbortSignal) {
      const result = v.parse(
        functionsValidator,
        await readWithSignal(
          () => api.listBranchFunctions(progress.target.projectId, progress.target.branchId),
          waitSignal,
        ),
      );
      const matches = result.filter((fn) => fn.slug === slug);
      if (matches.length > 1) throw new Error("Ambiguous provider function");
      return matches[0];
    }
    try {
      for (const fn of progress.functions) {
        const deadline = AbortSignal.timeout(timeoutMs);
        const waitSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
        await assertTarget(waitSignal);
        const observed = await observe(fn.slug, waitSignal);
        const latestId = observed?.currentDeployment?.id ?? observed?.activeDeploymentId ?? null;
        if (fn.state === "completed") {
          if (
            !observed ||
            observed.id !== fn.functionId ||
            observed.activeDeploymentId !== fn.deploymentId ||
            latestId !== fn.deploymentId ||
            observed.currentDeployment?.status !== "completed"
          )
            throw new Error("Completed deployment no longer matches provider state");
          continue;
        }
        if (fn.state === "submitting" && (latestId !== fn.baselineId || (observed?.id ?? null) !== fn.functionId))
          throw new Error("Unacknowledged function deployment requires reconciliation");
        if (fn.state === "failed" && latestId !== fn.deploymentId) throw new Error("Failed deployment was replaced");
        if (fn.state !== "submitted") {
          fn.baselineId = latestId;
          fn.functionId = observed?.id ?? null;
          fn.state = "submitting";
          await writeFunctionReceipt(directory, progress);
          const recordingApi: NeonApi = {
            ...api,
            getProject: (id) => readWithSignal(() => api.getProject(id), waitSignal),
            listBranches: (id) => readWithSignal(() => api.listBranches(id), waitSignal),
            listEndpoints: (id) => readWithSignal(() => api.listEndpoints(id), waitSignal),
            listBranchFunctions: (projectId, branchId) =>
              readWithSignal(() => api.listBranchFunctions(projectId, branchId), waitSignal),
            deployBranchFunction: async (projectId, branchId, slug, deployment) => {
              if (
                projectId !== progress.target.projectId ||
                branchId !== progress.target.branchId ||
                slug !== fn.slug ||
                digest(deployment.bundle) !== fn.bundleHash ||
                fn.state !== "submitting"
              )
                throw new Error("Unexpected function deployment");
              await assertTarget(waitSignal);
              const before = await observe(slug, waitSignal);
              if (
                (before?.currentDeployment?.id ?? before?.activeDeploymentId ?? null) !== fn.baselineId ||
                (before?.id ?? null) !== fn.functionId
              )
                throw new Error("Provider function changed before submission");
              waitSignal.throwIfAborted();
              const accepted = v.parse(
                deploymentValidator,
                await api.deployBranchFunction(projectId, branchId, slug, deployment),
              );
              fn.deploymentId = accepted.id;
              fn.deploymentIds.push(accepted.id);
              fn.state = "submitted";
              await writeFunctionReceipt(directory, progress);
              return accepted;
            },
          };
          await apply(
            neonFunctionPolicy(
              [{ role: fn.role, slug: fn.slug, source: options.entries[fn.role] }],
              environment.variables,
            ),
            {
              projectId: progress.target.projectId,
              branchId: progress.target.branchId,
              api: recordingApi,
              allowProtectedBranch: progress.target.protected,
              bundleFunction: async (resolved) => {
                const archive = archives.get(resolved.slug);
                if (!archive || resolved.slug !== fn.slug) throw new Error("Unexpected function bundle");
                return archive;
              },
            },
          );
        }
        for (;;) {
          waitSignal.throwIfAborted();
          const current = await observe(fn.slug, waitSignal);
          waitSignal.throwIfAborted();
          const deployment = current?.currentDeployment;
          if (current && fn.functionId !== null && current.id !== fn.functionId)
            throw new Error("Provider function was replaced");
          if (deployment && fn.deploymentId !== null && deployment.id > fn.deploymentId)
            throw new Error("Function deployment was superseded");
          if (deployment?.id === fn.deploymentId) {
            if (current && fn.functionId === null) {
              fn.functionId = current.id;
              await writeFunctionReceipt(directory, progress);
            }
            if (deployment.status === "failed") {
              fn.state = "failed";
              await writeFunctionReceipt(directory, progress);
              throw new Error("Provider function deployment failed");
            }
            if (deployment.status === "completed" && current?.activeDeploymentId === fn.deploymentId) {
              const url = URL.parse(current.invocationUrl);
              if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
                throw new Error("Invalid function invocation URL");
              fn.state = "completed";
              fn.functionId = current.id;
              fn.invocationUrl = url.href;
              await writeFunctionReceipt(directory, progress);
              break;
            }
          }
          await setTimeout(250, undefined, { signal: waitSignal });
        }
      }
      await assertTarget();
    } catch {
      throw new Error("Function deployment incomplete; inspect the saved function receipt before resuming");
    }
    return Object.freeze({ path: join(directory, "functions.json"), receipt: structuredClone(progress) });
  });
}
