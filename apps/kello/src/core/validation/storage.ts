import * as v from "valibot";

/** Initial single-object limit also bounds the memory used while verifying an upload. */
export const maximumUploadBytes = 10 * 1024 * 1024;
export const storageIntentValidator = v.strictObject({
  id: v.pipe(v.string(), v.uuid(), v.toLowerCase()),
  bucket: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)),
  size: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(maximumUploadBytes)),
  contentType: v.pipe(
    v.string(),
    v.maxLength(128),
    v.regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
  ),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
export type StorageIntent = v.InferOutput<typeof storageIntentValidator>;
export const storageUploadValidator = v.omit(storageIntentValidator, ["id"]);
export type StorageUpload = v.InferOutput<typeof storageUploadValidator>;

export const storageRequestValidator = v.variant("operation", [
  v.strictObject({
    protocol: v.number(),
    operation: v.literal("create"),
    upload: storageUploadValidator,
    requestKey: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,128}$/)),
  }),
  v.strictObject({
    protocol: v.number(),
    operation: v.picklist(["status", "signUpload", "finalize", "signDownload"]),
    id: storageIntentValidator.entries.id,
  }),
]);
export const storageStatusValidator = v.pipe(
  v.strictObject({
    id: storageIntentValidator.entries.id,
    state: v.picklist(["pending", "ready", "failed"]),
    errorCode: v.nullable(v.picklist(["VERIFICATION_FAILED", "EXPIRED"])),
  }),
  v.check((value) => (value.state === "failed") === (value.errorCode !== null)),
);
const signedUrl = v.pipe(
  v.string(),
  v.maxLength(16384),
  v.url(),
  v.check((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  }),
);
export const storageSignedUploadValidator = v.strictObject({
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
  url: signedUrl,
  method: v.literal("PUT"),
  headers: v.record(v.string(), v.string()),
});
export const storageSignedDownloadValidator = v.strictObject({ url: signedUrl, method: v.literal("GET") });
export type StorageRequest = v.InferOutput<typeof storageRequestValidator>;
export type StorageStatus = v.InferOutput<typeof storageStatusValidator>;
export type StorageSignedUpload = v.InferOutput<typeof storageSignedUploadValidator>;
export type StorageSignedDownload = v.InferOutput<typeof storageSignedDownloadValidator>;
