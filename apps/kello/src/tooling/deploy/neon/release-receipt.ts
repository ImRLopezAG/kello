import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { neonTriggerBindingValidator } from "kello/neon";
import * as v from "valibot";
import { resolveProjectPath } from "../../config/paths";
import { databaseIdentifier } from "../../migrations/connection";
import { releaseSchemaRangeValidator } from "../compatibility";
import { writeReceiptFile } from "../receipt-file";
import { publishDeploymentMetric } from "../observability";
import { triggerValidator } from "./triggers";

const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const identityValidator = v.strictObject({
  deployment: id,
  version: hash,
  inputHash: hash,
  target: v.strictObject({
    environment: v.picklist(["preview", "production"]),
    projectId: id,
    branchId: id,
    branchName: id,
    endpointId: id,
    postgresVersion: v.literal(18),
    protected: v.boolean(),
  }),
  database: v.strictObject({
    endpointHost: id,
    databaseName: databaseIdentifier,
    namespace: databaseIdentifier,
    metadataNamespace: databaseIdentifier,
  }),
  schema: releaseSchemaRangeValidator,
  migrationHashes: v.array(hash),
});
const functionFields = {
  functionId: id,
  deploymentId: v.pipe(v.number(), v.integer(), v.minValue(1)),
  slug: v.pipe(v.string(), v.regex(/^[a-z0-9]{1,20}$/)),
};
const functions = v.tuple([
  v.strictObject({ role: v.literal("service"), ...functionFields }),
  v.strictObject({ role: v.literal("worker"), ...functionFields }),
]);
const stageValidator = v.variant("stage", [
  v.strictObject({ stage: v.literal("metadata") }),
  v.strictObject({ stage: v.literal("quarantine"), revokedGrants: count, cancelledJobs: count }),
  v.strictObject({ stage: v.literal("migrations"), head: hash }),
  v.strictObject({ stage: v.literal("prepared") }),
  v.strictObject({ stage: v.literal("bootstrap"), artifactHash: hash, functions }),
  v.strictObject({
    stage: v.literal("triggers"),
    triggers: v.array(triggerValidator),
    bindings: v.record(id, neonTriggerBindingValidator),
  }),
  v.strictObject({ stage: v.literal("functions"), artifactHash: hash, functions }),
  v.strictObject({ stage: v.literal("health") }),
  v.strictObject({ stage: v.literal("activated") }),
  v.strictObject({ stage: v.literal("complete"), enabledTriggerIds: v.array(id) }),
]);
const receiptValidator = v.strictObject({
  format: v.literal(1),
  identity: identityValidator,
  completed: v.array(stageValidator),
});
export type NeonReleaseIdentity = v.InferOutput<typeof identityValidator>;
export type NeonReleaseStage = v.InferOutput<typeof stageValidator>;
export type NeonReleaseReceipt = v.InferOutput<typeof receiptValidator>;
export interface NeonReleaseJournal {
  read(): NeonReleaseReceipt;
  complete(stage: NeonReleaseStage): Promise<void>;
}
const order = [
  "metadata",
  "quarantine",
  "migrations",
  "prepared",
  "bootstrap",
  "triggers",
  "functions",
  "health",
  "activated",
  "complete",
] as const;

function validateReceipt(receipt: NeonReleaseReceipt): void {
  if (receipt.completed.some((stage, index) => stage.stage !== order[index]))
    throw new Error("Release stage order is invalid");
  if (new Set(receipt.identity.migrationHashes).size !== receipt.identity.migrationHashes.length)
    throw new Error("Duplicate release migration hash");
  for (const stage of receipt.completed) {
    if (
      stage.stage === "quarantine" &&
      receipt.identity.target.environment === "production" &&
      (stage.revokedGrants !== 0 || stage.cancelledJobs !== 0)
    )
      throw new Error("Production release cannot quarantine work");
    if (stage.stage === "migrations" && stage.head !== receipt.identity.schema.target)
      throw new Error("Release schema does not match the migration acknowledgement");
    if (
      (stage.stage === "bootstrap" || stage.stage === "functions") &&
      (stage.functions[0].functionId === stage.functions[1].functionId ||
        stage.functions[0].slug === stage.functions[1].slug)
    )
      throw new Error("Release functions must be distinct");
    if (stage.stage === "functions") {
      const bootstrap = receipt.completed.find((entry) => entry.stage === "bootstrap");
      if (
        !bootstrap ||
        stage.functions.some(
          (entry, index) =>
            entry.functionId !== bootstrap.functions[index]?.functionId ||
            entry.slug !== bootstrap.functions[index]?.slug,
        )
      )
        throw new Error("Release function identity changed");
    }
    if (stage.stage === "triggers") {
      const ids = stage.triggers.map((trigger) => trigger.triggerId);
      const bootstrap = receipt.completed.find((entry) => entry.stage === "bootstrap");
      if (stage.triggers.some((trigger) => trigger.functionSlug !== bootstrap?.functions[1].slug))
        throw new Error("Release trigger worker identity changed");
      if (
        new Set(ids).size !== ids.length ||
        stage.triggers.some((trigger) => trigger.enabled) ||
        Object.keys(stage.bindings).length !== ids.length ||
        ids.some((id) => !Object.hasOwn(stage.bindings, id))
      )
        throw new Error("Release trigger bindings are invalid");
    }
    if (stage.stage === "complete") {
      const prepared = receipt.completed.find((entry) => entry.stage === "triggers");
      const expected = prepared?.triggers.map((trigger) => trigger.triggerId).sort();
      if (JSON.stringify([...stage.enabledTriggerIds].sort()) !== JSON.stringify(expected))
        throw new Error("Release enabled triggers differ from preparation");
    }
  }
}

/** Saves acknowledgements only. The caller owns the database lock and must re-observe remote state before resume. */
export async function withNeonReleaseReceipt<T>(
  root: string,
  releaseKey: string,
  input: NeonReleaseIdentity,
  operation: (journal: NeonReleaseJournal) => Promise<T>,
): Promise<T> {
  if (!v.is(hash, releaseKey)) throw new Error("Invalid release key");
  const parsedIdentity = v.safeParse(identityValidator, structuredClone(input));
  if (!parsedIdentity.success) throw new Error("Invalid release identity");
  const identity = parsedIdentity.output;
  const directory = await resolveProjectPath(root, `.loom/releases/${releaseKey}`);
  await mkdir(directory, { recursive: true });
  const lock = join(directory, "release.lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error("Release receipt is locked");
  }
  try {
    const existing = await readReceiptFile(join(directory, "release.json"));
    let receipt: NeonReleaseReceipt = existing ?? { format: 1, identity, completed: [] };
    validateReceipt(receipt);
    if (JSON.stringify(receipt.identity) !== JSON.stringify(identity))
      throw new Error("Release receipt identity changed");
    if (!existing) await writeReceiptFile(directory, "release.json", JSON.stringify(receipt, null, 2) + "\n");
    let closed = false;
    let busy = false;
    let uncertain = false;
    let pending: Promise<void> | undefined;
    function assertOpen(): void {
      if (closed) throw new Error("Release receipt session is closed");
      if (uncertain) throw new Error("Release receipt write is uncertain; reopen before resuming");
    }
    const journal: NeonReleaseJournal = Object.freeze({
      read: () => {
        assertOpen();
        return structuredClone(receipt);
      },
      complete: async (input: NeonReleaseStage) => {
        assertOpen();
        if (busy) throw new Error("Release acknowledgements must run sequentially");
        const parsedStage = v.safeParse(stageValidator, structuredClone(input));
        if (!parsedStage.success) throw new Error("Invalid release acknowledgement");
        const stage = parsedStage.output;
        const prior = receipt.completed.find((entry) => entry.stage === stage.stage);
        if (prior) {
          if (JSON.stringify(prior) !== JSON.stringify(stage)) throw new Error("Release acknowledgement conflict");
          publishDeploymentMetric({ type: "release.acknowledgement", stage: stage.stage, status: "replayed" });
          return;
        }
        const next = { ...receipt, completed: [...receipt.completed, stage] };
        validateReceipt(next);
        busy = true;
        const write = writeReceiptFile(directory, "release.json", JSON.stringify(next, null, 2) + "\n");
        pending = write.then(
          () => {},
          () => {},
        );
        try {
          await write;
          receipt = next;
        } catch {
          uncertain = true;
          publishDeploymentMetric({ type: "release.acknowledgement", stage: stage.stage, status: "write-error" });
          throw new Error("Release receipt write is uncertain; reopen before resuming");
        } finally {
          busy = false;
        }
        publishDeploymentMetric({ type: "release.acknowledgement", stage: stage.stage, status: "recorded" });
      },
    });
    try {
      return await operation(journal);
    } finally {
      closed = true;
      await pending;
    }
  } finally {
    await rm(lock, { recursive: true });
  }
}

/** Observes saved acknowledgements without creating a receipt or taking its write lock. */
export async function readNeonReleaseReceipt(root: string, releaseKey: string): Promise<NeonReleaseReceipt | null> {
  if (!v.is(hash, releaseKey)) throw new Error("Invalid release key");
  const path = await resolveProjectPath(root, `.loom/releases/${releaseKey}/release.json`);
  const receipt = await readReceiptFile(path);
  if (receipt) validateReceipt(receipt);
  return receipt;
}

async function readReceiptFile(path: string): Promise<NeonReleaseReceipt | null> {
  try {
    return v.parse(receiptValidator, JSON.parse(await readFile(path, "utf8")));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw new Error("Could not read release receipt");
  }
}
