import { createKelloNeonApi } from "../../neon/api";
import type { NeonApi } from "@neon/config-runtime/v1";
import { storageUploadValidator } from "kello/server";
import * as v from "valibot";
import { configValidator } from "../../config/define-config";
import type { KelloConfig } from "../../config/define-config";
import { inspectDeploymentTarget } from "./target";
import type { DeploymentEnvironment, DeploymentProvider, DeploymentTarget } from "./target";

export type DeploymentStorageProvider = DeploymentProvider & Pick<NeonApi, "listBranchBuckets" | "createBranchBucket">;
export interface NeonStorageBucketOptions {
  readonly config: KelloConfig;
  readonly environment: DeploymentEnvironment;
  readonly buckets: readonly string[];
}
const bucketValidator = v.object({
  name: storageUploadValidator.entries.bucket,
  accessLevel: v.picklist(["private", "public_read"]),
});

export async function readStorageBuckets(
  api: Pick<NeonApi, "listBranchBuckets">,
  target: Pick<DeploymentTarget, "projectId" | "branchId">,
) {
  const buckets = v.parse(v.array(bucketValidator), await api.listBranchBuckets(target.projectId, target.branchId));
  if (new Set(buckets.map((bucket) => bucket.name)).size !== buckets.length)
    throw new Error("Ambiguous storage buckets");
  return new Map(buckets.map((bucket) => [bucket.name, bucket]));
}

/** Creates only missing private buckets. Existing public buckets are never silently changed or adopted. */
export async function prepareNeonStorageBuckets(
  options: NeonStorageBucketOptions,
  provider?: DeploymentStorageProvider,
) {
  const config = v.parse(configValidator, options.config);
  const environment = v.parse(v.picklist(["preview", "production"]), options.environment);
  const names = v.parse(
    v.pipe(
      v.array(storageUploadValidator.entries.bucket),
      v.check((names) => new Set(names).size === names.length),
    ),
    [...options.buckets],
  );
  try {
    const api: DeploymentStorageProvider = provider ?? createKelloNeonApi();
    const target = await inspectDeploymentTarget(config, environment, api);
    async function verify() {
      const current = await inspectDeploymentTarget(config, environment, api);
      if (JSON.stringify(current) !== JSON.stringify(target)) throw new Error("Storage target changed");
      const buckets = await readStorageBuckets(api, target);
      for (const name of names) {
        const bucket = buckets.get(name);
        if (bucket && bucket.accessLevel !== "private") throw new Error("Storage bucket must be private");
      }
      return buckets;
    }
    for (const name of names) {
      const buckets = await verify();
      if (!buckets.has(name))
        v.parse(
          bucketValidator,
          await api.createBranchBucket(target.projectId, target.branchId, { name, accessLevel: "private" }),
        );
    }
    const final = names.length ? await verify() : new Map<string, v.InferOutput<typeof bucketValidator>>();
    const buckets = names.map((name) => {
      const bucket = final.get(name);
      if (!bucket || bucket.accessLevel !== "private") throw new Error("Provider did not create a private bucket");
      return Object.freeze(bucket);
    });
    return Object.freeze({ target, buckets: Object.freeze(buckets) });
  } catch {
    throw new Error("Could not prepare Neon storage buckets");
  }
}
