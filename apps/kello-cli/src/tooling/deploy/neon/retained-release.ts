import { readNeonReleaseReceipt } from "./release-receipt";
import type { NeonReleaseIdentity } from "./release-receipt";

/** A new release may reuse completed code receipts, never old health or activation observations. */
export async function inspectRetainedRelease(
  root: string,
  key: string,
  identity: Pick<NeonReleaseIdentity, "deployment" | "version" | "target" | "database" | "migrationHashes">,
  slugs: Readonly<{ service: string; worker: string }>,
) {
  const receipt = await readNeonReleaseReceipt(root, key);
  if (
    !receipt ||
    !receipt.completed.some((stage) => stage.stage === "complete") ||
    receipt.identity.deployment !== identity.deployment ||
    receipt.identity.version !== identity.version ||
    JSON.stringify(receipt.identity.target) !== JSON.stringify(identity.target) ||
    JSON.stringify(receipt.identity.database) !== JSON.stringify(identity.database) ||
    receipt.identity.migrationHashes.some((hash, index) => identity.migrationHashes[index] !== hash)
  )
    throw new Error("Retained release identity or migration history differs");
  const bootstrap = receipt.completed.find((stage) => stage.stage === "bootstrap");
  const triggers = receipt.completed.find((stage) => stage.stage === "triggers");
  const functions = receipt.completed.find((stage) => stage.stage === "functions");
  if (!bootstrap || !triggers || !functions || functions.functions.some((fn) => fn.slug !== slugs[fn.role]))
    throw new Error("Retained release function identity differs");
  return { bootstrap, triggers, functions };
}
