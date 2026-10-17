/** Explicit provider acceptance on the authorized disposable branch; not part of offline tests. */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createNeonObjectStorage } from "kello/neon";
import { createKelloNeonApi, defineConfig, inspectDeploymentTarget } from "kello/tooling";

const projectId = "late-moon-69483649";
const branchId = "br-dark-block-awbbt60w";
const run = crypto.randomUUID();
const bucket = `kello-smoke-${run}`;
const credentialName = `kello-storage-smoke-${run}`;
const payload = Buffer.from(`Kello actual cloud storage ${run}`);
const intent = {
  id: run,
  bucket,
  size: payload.byteLength,
  contentType: "text/plain",
  sha256: createHash("sha256").update(payload).digest("hex"),
};
const api = createKelloNeonApi();
const cleanupErrors: string[] = [];
const report = {
  run,
  bucket,
  stage: "admission",
  upload: false,
  seal: false,
  download: false,
  repeatSeal: false,
  removed: false,
  bucketRemoved: false,
  credentialRevoked: false,
  failed: false,
  cleanupErrors,
};
let storage: ReturnType<typeof createNeonObjectStorage> | undefined;
let tokenId: string | undefined;
let bucketAttempted = false;
let credentialAttempted = false;
try {
  const target = await inspectDeploymentTarget(
    defineConfig({
      project: "acceptance",
      provider: { projectId, targets: { preview: { branchId, protected: false } } },
    }),
    "preview",
    api,
  );
  assert.equal(target.branchName, "loom-acceptance-kello-002-optimistic-20261007");
  assert.equal(target.endpointId, "ep-solitary-block-awijudvn");
  assert.equal(target.protected, false);
  assert(!(await api.listBranchBuckets(projectId, branchId)).some((entry) => entry.name === bucket));
  assert(!(await api.listCredentials(projectId, branchId)).some((entry) => entry.name === credentialName));
  const connection = await api.getProjectBranchStorage(projectId, branchId);
  assert(connection, "Storage must already be enabled");
  report.stage = "bucket";
  bucketAttempted = true;
  assert.equal(
    (await api.createBranchBucket(projectId, branchId, { name: bucket, accessLevel: "private" })).accessLevel,
    "private",
  );
  report.stage = "credential";
  credentialAttempted = true;
  const credential = await api.createCredential(projectId, branchId, {
    name: credentialName,
    principalType: "user",
    scopes: ["storage:read", "storage:write"],
  });
  tokenId = credential.tokenId;
  assert.equal(credential.branchId, branchId);
  storage = createNeonObjectStorage({
    projectId,
    branchId,
    endpoint: connection.s3Endpoint,
    region: connection.region,
    credentials: { accessKeyId: credential.tokenId, secretAccessKey: credential.s3SecretAccessKey },
  });
  report.stage = "upload";
  const upload = await storage.signUpload(intent, 60);
  const uploaded = await fetch(upload.url, {
    method: upload.method,
    headers: upload.headers,
    body: payload,
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(uploaded.ok, true);
  await uploaded.body?.cancel();
  report.upload = true;
  report.stage = "seal";
  const sealed = await storage.sealUpload(intent);
  assert.equal(sealed.sha256, intent.sha256);
  assert.equal(sealed.size, payload.byteLength);
  report.seal = true;
  assert.deepEqual(await storage.sealUpload(intent), sealed);
  report.repeatSeal = true;
  report.stage = "download";
  const signed = await storage.signDownload(intent, 60);
  const downloaded = await fetch(signed.url, { signal: AbortSignal.timeout(30_000) });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), payload);
  report.download = true;
  report.stage = "remove";
  await storage.remove(intent, "pending");
  await storage.remove(intent, "ready");
  await assert.rejects(storage.signDownload(intent, 60));
  report.removed = true;
  report.stage = "complete";
} catch {
  report.failed = true;
  process.exitCode = 1;
} finally {
  // Independent cleanup keeps a failed object operation from skipping credential retirement.
  if (storage) {
    for (const state of ["pending", "ready"] as const) {
      try {
        await storage.remove(intent, state);
      } catch {
        report.cleanupErrors.push(`object-${state}`);
      }
    }
    storage.close();
  }
  if (credentialAttempted) {
    try {
      const matches = (await api.listCredentials(projectId, branchId)).filter((entry) => entry.name === credentialName);
      assert(matches.length <= 1, "Ambiguous own credential");
      for (const entry of matches) {
        assert(!tokenId || entry.tokenId === tokenId, "Own credential changed");
        if (!entry.revokedAt) await api.revokeCredential(projectId, branchId, entry.tokenId);
      }
      assert(
        !(await api.listCredentials(projectId, branchId)).some(
          (entry) => entry.name === credentialName && !entry.revokedAt,
        ),
      );
      report.credentialRevoked = true;
    } catch {
      report.cleanupErrors.push("credential");
    }
  }
  if (bucketAttempted) {
    try {
      if ((await api.listBranchBuckets(projectId, branchId)).some((entry) => entry.name === bucket))
        await api.deleteBranchBucket(projectId, branchId, bucket);
      assert(!(await api.listBranchBuckets(projectId, branchId)).some((entry) => entry.name === bucket));
      report.bucketRemoved = true;
    } catch {
      report.cleanupErrors.push("bucket");
    }
  }
  if (report.cleanupErrors.length) {
    report.failed = true;
    process.exitCode = 1;
  }
  await writeFile(join(tmpdir(), `kello-cloud-u6-storage-${run}.json`), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
