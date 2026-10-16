import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { writeReceiptFile } from "../receipt-file";
import { resolveProjectPath } from "../../config/paths";

const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const deploymentId = v.pipe(v.number(), v.integer(), v.minValue(1));
const functionReceipt = v.strictObject({
  role: v.picklist(["service", "worker"]),
  slug: v.pipe(v.string(), v.regex(/^[a-z0-9]{1,20}$/)),
  bundleHash: hash,
  state: v.picklist(["ready", "submitting", "submitted", "completed", "failed"]),
  baselineId: v.nullable(deploymentId),
  deploymentId: v.nullable(deploymentId),
  deploymentIds: v.array(deploymentId),
  functionId: v.nullable(id),
  invocationUrl: v.nullable(v.string()),
});
const receiptValidator = v.strictObject({
  format: v.literal(1),
  target: v.strictObject({
    environment: v.picklist(["preview", "production"]),
    projectId: id,
    branchId: id,
    branchName: id,
    endpointId: id,
    postgresVersion: v.literal(18),
    protected: v.boolean(),
  }),
  version: hash,
  artifactHash: hash,
  inputHash: hash,
  functions: v.tuple([functionReceipt, functionReceipt]),
});
export type NeonFunctionReceipt = v.InferOutput<typeof receiptValidator>;

export async function readNeonFunctionReceipt(root: string, artifactHash: string): Promise<NeonFunctionReceipt> {
  const directory = await receiptDirectory(root, artifactHash);
  const receipt = await loadFunctionReceipt(directory);
  if (!receipt) throw new Error("Could not read Neon function receipt");
  return receipt;
}

export async function loadFunctionReceipt(directory: string): Promise<NeonFunctionReceipt | undefined> {
  try {
    return v.parse(receiptValidator, JSON.parse(await readFile(join(directory, "functions.json"), "utf8")));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw new Error("Could not read Neon function receipt");
  }
}

export async function receiptDirectory(root: string, artifactHash: string): Promise<string> {
  if (!v.is(hash, artifactHash)) throw new Error("Invalid deployment artifact hash");
  return resolveProjectPath(root, `.loom/deploy/${artifactHash}`);
}

/** Atomic replacement plus file/directory sync preserves acknowledged provider progress across process interruption. */
export async function writeFunctionReceipt(directory: string, receipt: NeonFunctionReceipt): Promise<void> {
  const contents = JSON.stringify(v.parse(receiptValidator, receipt), null, 2) + "\n";
  await writeReceiptFile(directory, "functions.json", contents);
}

/** A local apply never takes over another process's or an abandoned process's lock. */
export async function withFunctionApplyLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const state = await resolveProjectPath(root, ".loom/deploy");
  await mkdir(state, { recursive: true });
  const lock = join(state, "functions.lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error("Function deployment is locked");
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true });
  }
}
