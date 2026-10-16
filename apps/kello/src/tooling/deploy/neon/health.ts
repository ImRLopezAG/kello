import { createKelloNeonApi } from "../../neon/api";
import type { NeonApi } from "@neon/config-runtime/v1";
import * as v from "valibot";
import { setTimeout } from "node:timers/promises";
import { configValidator } from "../../config/define-config";
import type { KelloConfig } from "../../config/define-config";
import { readNeonFunctionReceipt } from "./receipt";
import { inspectDeploymentTarget } from "./target";
import type { DeploymentEnvironment, DeploymentProvider } from "./target";
import { readWithSignal } from "./observe";

export type DeploymentHealthProvider = DeploymentProvider & Pick<NeonApi, "listBranchFunctions">;
type HealthStage =
  | "validate receipt"
  | "observe deployments"
  | "service health"
  | "worker health"
  | "confirm deployments";
/** Safe diagnostics only: never includes provider messages, URLs, or credentials. */
export class NeonFunctionHealthError extends Error {
  constructor(
    readonly stage: HealthStage,
    readonly aborted: boolean,
    readonly status?: number,
    readonly identityMismatch?: "version" | "artifactHash" | "role",
  ) {
    super("Deployment health verification failed");
  }
}
export interface NeonFunctionHealthOptions {
  readonly config: KelloConfig;
  readonly environment: DeploymentEnvironment;
  readonly artifactHash: string;
  /** A recorded bootstrap may briefly remain on the data plane after final deployment completion. */
  readonly previousArtifactHash?: string | undefined;
  readonly activationToken: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
const digest = v.pipe(v.string(), v.length(64), v.regex(/^[a-f0-9]+$/));
const healthValidator = v.strictObject({
  format: v.literal(1),
  databaseDrainProtocol: v.optional(v.picklist([0, 1]), 0),
  version: digest,
  artifactHash: digest,
  role: v.picklist(["service", "worker"]),
});
function invocationAddress(value: string): URL {
  const address = new URL(value);
  if (address.protocol !== "https:" || address.username || address.password || address.search || address.hash)
    throw new Error("Invalid invocation address");
  return address;
}
async function readHealth(response: Response) {
  if (
    response.status !== 200 ||
    response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("Invalid health response");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) throw new Error("Health response too large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return v.parse(healthValidator, JSON.parse(text + decoder.decode()));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Observes saved, completed deployments over verified HTTPS. Never activates grants or modifies receipts. */
export async function inspectNeonFunctionHealth(
  root: string,
  input: NeonFunctionHealthOptions,
  provider?: DeploymentHealthProvider,
) {
  let stage: HealthStage = "validate receipt";
  let signal: AbortSignal | undefined;
  let status: number | undefined;
  let identityMismatch: "version" | "artifactHash" | "role" | undefined;
  try {
    const { signal: callerSignal, ...values } = input;
    const options = structuredClone(values);
    const config = v.parse(configValidator, options.config);
    const token = v.parse(digest, options.activationToken);
    const timeout = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error("Invalid timeout");
    signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(callerSignal ? [callerSignal] : [])]);
    const healthSignal = signal;
    signal.throwIfAborted();
    const receipt = await readNeonFunctionReceipt(root, options.artifactHash);
    if (
      receipt.artifactHash !== options.artifactHash ||
      receipt.functions[0].role !== "service" ||
      receipt.functions[1].role !== "worker" ||
      new Set(receipt.functions.map((fn) => fn.slug)).size !== 2 ||
      new Set(receipt.functions.map((fn) => fn.functionId)).size !== 2 ||
      receipt.functions.some(
        (fn) => fn.state !== "completed" || !fn.functionId || !fn.deploymentId || !fn.invocationUrl,
      )
    )
      throw new Error("Incomplete function receipt");
    const previous = options.previousArtifactHash
      ? await readNeonFunctionReceipt(root, v.parse(digest, options.previousArtifactHash))
      : undefined;
    if (
      previous &&
      (previous.artifactHash !== options.previousArtifactHash ||
        previous.artifactHash === receipt.artifactHash ||
        previous.version !== receipt.version ||
        JSON.stringify(previous.target) !== JSON.stringify(receipt.target) ||
        previous.functions.some(
          (fn, index) =>
            fn.state !== "completed" ||
            fn.role !== receipt.functions[index]?.role ||
            fn.functionId !== receipt.functions[index]?.functionId ||
            fn.slug !== receipt.functions[index]?.slug,
        ))
    )
      throw new Error("Invalid previous function receipt");
    const api = provider ?? createKelloNeonApi();
    async function observe() {
      const target = await readWithSignal(
        () => inspectDeploymentTarget(config, options.environment, api),
        healthSignal,
      );
      if (JSON.stringify(target) !== JSON.stringify(receipt.target)) throw new Error("Target changed");
      const functions = await readWithSignal(
        () => api.listBranchFunctions(target.projectId, target.branchId),
        healthSignal,
      );
      for (const expected of receipt.functions) {
        const matches = functions.filter((fn) => fn.slug === expected.slug);
        const current = matches[0];
        if (
          !current ||
          matches.length !== 1 ||
          current.id !== expected.functionId ||
          current.activeDeploymentId !== expected.deploymentId ||
          current.currentDeployment?.id !== expected.deploymentId ||
          current.currentDeployment.status !== "completed" ||
          !expected.invocationUrl ||
          invocationAddress(current.invocationUrl).href !== invocationAddress(expected.invocationUrl).href
        )
          throw new Error("Function deployment changed");
      }
      healthSignal.throwIfAborted();
    }
    stage = "observe deployments";
    await observe();
    const protocols = new Map<"service" | "worker", 0 | 1>();
    for (const fn of receipt.functions) {
      stage = fn.role === "service" ? "service health" : "worker health";
      status = undefined;
      if (!fn.invocationUrl) throw new Error("Missing invocation address");
      for (;;) {
        signal.throwIfAborted();
        identityMismatch = undefined;
        const response = await fetch(
          `${invocationAddress(fn.invocationUrl).href.replace(/\/$/, "")}/_loom/deployment/health`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            redirect: "error",
            cache: "no-store",
            signal,
          },
        );
        status = response.status;
        const health = await readHealth(response);
        if (
          previous &&
          health.version === receipt.version &&
          health.role === fn.role &&
          health.artifactHash === previous.artifactHash
        ) {
          identityMismatch = "artifactHash";
          await setTimeout(250, undefined, { signal });
          await observe();
          continue;
        }
        if (health.version !== receipt.version) identityMismatch = "version";
        else if (health.artifactHash !== receipt.artifactHash) identityMismatch = "artifactHash";
        else if (health.role !== fn.role) identityMismatch = "role";
        if (identityMismatch) throw new Error("Unexpected runtime build");
        protocols.set(fn.role, health.databaseDrainProtocol);
        break;
      }
    }
    stage = "confirm deployments";
    status = undefined;
    await observe();
    return Object.freeze({
      target: receipt.target,
      version: receipt.version,
      artifactHash: receipt.artifactHash,
      functions: receipt.functions.map(({ role, functionId, deploymentId }) =>
        Object.freeze({ role, functionId, deploymentId, databaseDrainProtocol: protocols.get(role) ?? 0 }),
      ),
    });
  } catch {
    throw new NeonFunctionHealthError(stage, signal?.aborted ?? false, status, identityMismatch);
  }
}
