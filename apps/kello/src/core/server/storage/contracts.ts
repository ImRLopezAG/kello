import * as v from "valibot";
import { storageIntentValidator, storageUploadValidator } from "../../validation/storage";
import type { StorageIntent } from "../../validation/storage";
export { storageIntentValidator, storageUploadValidator, maximumUploadBytes } from "../../validation/storage";
export type { StorageIntent, StorageUpload } from "../../validation/storage";
const identityPart = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
export const storageOwnerValidator = v.strictObject({
  issuer: identityPart,
  subject: identityPart,
  tenantId: v.exactOptional(identityPart),
});
export const storageObjectCreatedValidator = v.strictObject({
  intentId: storageIntentValidator.entries.id,
  ...storageUploadValidator.entries,
  uploadedBy: storageOwnerValidator,
});
export type StorageObjectCreatedEvent = v.InferOutput<typeof storageObjectCreatedValidator>;

export interface ObjectStorageBackend {
  remove(intent: StorageIntent, state: "pending" | "ready", signal?: AbortSignal): Promise<void>;
  readonly target: { readonly projectId: string; readonly branchId: string };
  signUpload(
    intent: StorageIntent,
    expiresIn: number,
  ): Promise<{
    readonly key: string;
    readonly url: string;
    readonly method: "PUT";
    readonly headers: Readonly<Record<string, string>>;
  }>;
  sealUpload(
    intent: StorageIntent,
    signal?: AbortSignal,
  ): Promise<{
    readonly key: string;
    readonly sha256: string;
    readonly size: number;
  }>;
  signDownload(
    intent: StorageIntent,
    expiresIn: number,
    signal?: AbortSignal,
    /** Persisted creation branch from an authorized ready intent, never request input. */
    origin?: { readonly branchId: string },
  ): Promise<{
    readonly url: string;
    readonly method: "GET";
  }>;
}

export class StorageVerificationError extends Error {
  constructor() {
    super("Storage verification failed");
  }
}

const intentErrors = {
  FORBIDDEN: "Storage access denied",
  IDEMPOTENCY_CONFLICT: "Storage request conflict",
  STORAGE_UNAVAILABLE: "Storage object or upload unavailable",
} as const;
export class StorageIntentError extends Error {
  constructor(readonly code: keyof typeof intentErrors) {
    super(intentErrors[code]);
  }
}
