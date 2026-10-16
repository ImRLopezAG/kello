import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { HeadObjectCommandOutput } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as v from "valibot";
import { storageIntentValidator, StorageVerificationError } from "../../server/storage/contracts";
import type { StorageIntent } from "../../server/storage/contracts";
import { storageKeyPrefix } from "../../server/storage/keys";

export interface NeonObjectStorageOptions {
  readonly projectId: string;
  readonly branchId: string;
  readonly endpoint: string;
  readonly region: string;
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string };
}
const configuration = v.strictObject({
  projectId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  branchId: v.pipe(v.string(), v.regex(/^br-[a-z0-9-]+$/)),
  endpoint: v.string(),
  region: v.pipe(v.string(), v.regex(/^[a-z]{2}-[a-z]+-\d+$/)),
  credentials: v.strictObject({
    accessKeyId: v.pipe(v.string(), v.minLength(1)),
    secretAccessKey: v.pipe(v.string(), v.minLength(1)),
  }),
});
const lifetime = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(300));

/** Capture validated options without creating a connection or exposing caller-owned mutable credentials. */
export function captureNeonStorageOptions(options: NeonObjectStorageOptions) {
  const parsed = v.safeParse(configuration, options);
  if (!parsed.success) throw new Error("Invalid storage configuration");
  const config = parsed.output;
  const endpoint = URL.parse(config.endpoint);
  if (
    !endpoint ||
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    !new RegExp(`^${config.branchId}\\.storage\\.c-\\d+\\.${config.region}\\.aws\\.neon\\.tech$`).test(
      endpoint.hostname,
    )
  )
    throw new Error("Storage endpoint does not match the configured branch");
  return Object.freeze({ ...config, endpoint: endpoint.href, credentials: Object.freeze({ ...config.credentials }) });
}

/** Trusted server adapter. The intent service owns authorization and durable pending/ready state. */
export function createNeonObjectStorage(options: NeonObjectStorageOptions, provider?: S3Client) {
  const config = captureNeonStorageOptions(options);
  const client =
    provider ??
    new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { ...config.credentials },
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 },
    });
  let closed = false;
  function capture(input: StorageIntent, originBranchId = config.branchId) {
    if (closed) throw new Error("Storage adapter closed");
    const intent = v.parse(storageIntentValidator, input);
    const branchId = v.parse(configuration.entries.branchId, originBranchId);
    const prefix = storageKeyPrefix(config.projectId, branchId);
    return {
      intent,
      pending: `${prefix}/pending/${intent.id}`,
      ready: `${prefix}/ready/${intent.id}/${intent.sha256}`,
      metadata: { "loom-intent": intent.id, "loom-branch": branchId, "loom-sha256": intent.sha256 },
    };
  }
  function verifyMetadata(
    observed: Pick<HeadObjectCommandOutput, "ContentLength" | "ContentType" | "Metadata">,
    expected: ReturnType<typeof capture>,
  ): void {
    if (
      observed.ContentLength !== expected.intent.size ||
      observed.ContentType !== expected.intent.contentType ||
      Object.entries(expected.metadata).some(([key, value]) => observed.Metadata?.[key] !== value)
    )
      throw new StorageVerificationError();
  }
  async function run<Result>(operation: (signal: AbortSignal) => Promise<Result>, signal?: AbortSignal) {
    const deadline = AbortSignal.timeout(30000);
    const current = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      current.throwIfAborted();
      return await operation(current);
    } catch (cause) {
      if (cause instanceof StorageVerificationError) throw cause;
      throw new Error("Storage operation failed");
    }
  }
  return Object.freeze({
    target: Object.freeze({ projectId: config.projectId, branchId: config.branchId }),
    async signUpload(input: StorageIntent, expiresIn: number) {
      const object = capture(input);
      const expires = v.parse(lifetime, expiresIn);
      const headers = {
        "content-type": object.intent.contentType,
        "content-length": String(object.intent.size),
        ...Object.fromEntries(Object.entries(object.metadata).map(([key, value]) => [`x-amz-meta-${key}`, value])),
      };
      return run(async () => {
        const url = await getSignedUrl(
          client,
          new PutObjectCommand({
            Bucket: object.intent.bucket,
            Key: object.pending,
            ContentLength: object.intent.size,
            ContentType: object.intent.contentType,
            Metadata: object.metadata,
          }),
          {
            expiresIn: expires,
            signableHeaders: new Set(Object.keys(headers)),
            unhoistableHeaders: new Set(Object.keys(headers)),
          },
        );
        return Object.freeze({ key: object.pending, url, method: "PUT" as const, headers: Object.freeze(headers) });
      });
    },
    async sealUpload(input: StorageIntent, signal?: AbortSignal) {
      const object = capture(input);
      return run(async (current) => {
        const sealed = Object.freeze({ key: object.ready, sha256: object.intent.sha256, size: object.intent.size });
        try {
          const existing = await client.send(
            new HeadObjectCommand({ Bucket: object.intent.bucket, Key: object.ready }),
            { abortSignal: current },
          );
          verifyMetadata(existing, object);
          return sealed;
        } catch (cause) {
          if (!(cause instanceof S3ServiceException) || cause.$metadata.httpStatusCode !== 404) throw cause;
        }
        const response = await client.send(
          new GetObjectCommand({ Bucket: object.intent.bucket, Key: object.pending }),
          { abortSignal: current },
        );
        if (!response.Body) throw new StorageVerificationError();
        const reader = response.Body.transformToWebStream().getReader();
        const body = Buffer.alloc(object.intent.size);
        let length = 0;
        try {
          verifyMetadata(response, object);
          for (;;) {
            current.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            const bytes = v.parse(v.instance(Uint8Array), chunk.value);
            length += bytes.byteLength;
            if (length > object.intent.size) throw new StorageVerificationError();
            body.set(bytes, length - bytes.byteLength);
          }
        } finally {
          await reader.cancel();
        }
        if (length !== object.intent.size || createHash("sha256").update(body).digest("hex") !== object.intent.sha256)
          throw new StorageVerificationError();
        current.throwIfAborted();
        await client.send(
          new PutObjectCommand({
            Bucket: object.intent.bucket,
            Key: object.ready,
            Body: body,
            ContentLength: body.byteLength,
            ContentType: object.intent.contentType,
            Metadata: object.metadata,
          }),
          { abortSignal: current },
        );
        // Only this server-held credential writes ready keys. A repeated seal writes identical verified bytes.
        return sealed;
      }, signal);
    },
    async signDownload(
      input: StorageIntent,
      expiresIn: number,
      signal?: AbortSignal,
      origin?: { readonly branchId: string },
    ) {
      const object = capture(input, origin?.branchId);
      const expires = v.parse(lifetime, expiresIn);
      return run(async (current) => {
        const observed = await client.send(new HeadObjectCommand({ Bucket: object.intent.bucket, Key: object.ready }), {
          abortSignal: current,
        });
        verifyMetadata(observed, object);
        current.throwIfAborted();
        const url = await getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: object.intent.bucket,
            Key: object.ready,
            ResponseContentDisposition: "attachment",
          }),
          { expiresIn: expires },
        );
        return Object.freeze({ url, method: "GET" as const });
      }, signal);
    },
    async remove(input: StorageIntent, state: "pending" | "ready", signal?: AbortSignal): Promise<void> {
      const object = capture(input);
      const kind = v.parse(v.picklist(["pending", "ready"]), state);
      return run(async (current) => {
        await client.send(new DeleteObjectCommand({ Bucket: object.intent.bucket, Key: object[kind] }), {
          abortSignal: current,
        });
      }, signal);
    },
    close(): void {
      closed = true;
      client.destroy();
    },
  });
}
