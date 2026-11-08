import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { storageProviderFixture } from "../fixtures/storage-provider";
import { createNeonObjectStorage, StorageVerificationError } from "kello/neon";

test("storage signs bounded uploads and seals verified bytes outside the client-writable key", async () => {
  const f = storageProviderFixture();
  try {
    const upload = await f.storage.signUpload(f.intent, 120);
    const url = new URL(upload.url);
    assert.equal(url.searchParams.get("X-Amz-Expires"), "120");
    assert.ok(url.searchParams.get("X-Amz-SignedHeaders")?.includes("content-length"));
    assert.ok(url.searchParams.get("X-Amz-SignedHeaders")?.includes("content-type"));
    assert.equal(upload.method, "PUT");
    assert.equal(upload.headers["content-type"], "text/plain");
    assert.equal(
      (await fetch(upload.url, { method: upload.method, headers: upload.headers, body: f.body })).status,
      200,
    );
    const sealed = await f.storage.sealUpload(f.intent);
    assert.notEqual(sealed.key, upload.key);
    assert.ok(sealed.key.includes("/ready/"));
    const ready = f.objects.get(`/uploads/${sealed.key}`);
    assert.deepEqual(ready?.body, f.body);
    // A still-live upload URL can only change staging, never the verified object.
    await fetch(upload.url, { method: "PUT", headers: upload.headers, body: Buffer.from("changed upload!") });
    // SQL may have failed after the ready object was written. Recover that write, without rereading staging.
    assert.deepEqual(await f.storage.sealUpload(f.intent), sealed);
    const download = await f.storage.signDownload(f.intent, 60);
    assert.deepEqual(Buffer.from(await (await fetch(download.url)).arrayBuffer()), f.body);
    await f.storage.remove(f.intent, "pending");
    assert.equal(f.objects.has(`/uploads/${upload.key}`), false);
    assert.equal(f.objects.has(`/uploads/${sealed.key}`), true);
    await f.storage.remove(f.intent, "ready");
    assert.equal(f.objects.size, 0);
  } finally {
    await f.cleanup();
  }
});

test("storage refuses unverified, mismatched and missing objects without publishing ready bytes", async () => {
  const f = storageProviderFixture();
  try {
    await assert.rejects(f.storage.signDownload(f.intent, 60), /Storage operation failed/);
    const upload = await f.storage.signUpload(f.intent, 120);
    const path = new URL(upload.url).pathname;
    const headers = { ...upload.headers };
    f.objects.set(path, { body: f.body, headers: { ...headers, "x-amz-meta-kello-intent": randomUUID() } });
    await assert.rejects(f.storage.sealUpload(f.intent), StorageVerificationError);
    f.objects.set(path, { body: Buffer.from("tampered upload"), headers });
    await assert.rejects(f.storage.sealUpload(f.intent), StorageVerificationError);
    f.objects.set(path, { body: Buffer.alloc(f.intent.size + 1), headers });
    await assert.rejects(f.storage.sealUpload(f.intent), StorageVerificationError);
    assert.equal(
      f.requests.some((request) => request.method === "PUT"),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("storage refuses another branch endpoint, invalid bounds and canceled work", async () => {
  assert.throws(() =>
    createNeonObjectStorage({
      projectId: "project",
      branchId: "br-preview",
      endpoint: "https://br-production.storage.c-1.us-east-2.aws.neon.tech",
      region: "us-east-2",
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    }),
  );
  const f = storageProviderFixture();
  try {
    await assert.rejects(f.storage.signUpload({ ...f.intent, size: 10 * 1024 * 1024 + 1 }, 120));
    await assert.rejects(f.storage.signUpload(f.intent, 3600));
    await assert.rejects(f.storage.signUpload({ ...f.intent, bucket: "../other" }, 120));
    await assert.rejects(f.storage.sealUpload(f.intent, AbortSignal.abort()));
    assert.equal(f.requests.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("inherited ready reads retain origin keys and metadata through the child provider only", async () => {
  const parent = storageProviderFixture();
  const child = storageProviderFixture("br-child");
  try {
    const upload = await parent.storage.signUpload(parent.intent, 60);
    await fetch(upload.url, { method: "PUT", headers: upload.headers, body: parent.body });
    const ready = await parent.storage.sealUpload(parent.intent);
    for (const [key, value] of parent.objects) child.objects.set(key, value);
    await assert.rejects(child.storage.signDownload(parent.intent, 60));
    const download = await child.storage.signDownload(parent.intent, 60, undefined, { branchId: "br-preview" });
    assert.equal(new URL(download.url).pathname, `/uploads/${ready.key}`);
    assert.notEqual(new URL(download.url).origin, new URL(upload.url).origin);
    assert.deepEqual(Buffer.from(await (await fetch(download.url)).arrayBuffer()), parent.body);
    await assert.rejects(child.storage.signDownload(parent.intent, 60, undefined, { branchId: "../br-preview" }));
    child.objects.get(`/uploads/${ready.key}`)!.headers["x-amz-meta-kello-branch"] = "br-other";
    await assert.rejects(
      child.storage.signDownload(parent.intent, 60, undefined, { branchId: "br-preview" }),
      StorageVerificationError,
    );
  } finally {
    await child.cleanup();
    await parent.cleanup();
  }
});
