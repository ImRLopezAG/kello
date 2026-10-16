import type { connectDatabase } from "./database/connection";
import type { ObjectStorageBackend } from "./storage/contracts";

export interface RuntimeStorageBackend {
  readonly projectId: string;
  readonly branchId: string;
  /** Creates a new backend owned by this runtime; called only after activation succeeds. */
  readonly connect: () => ObjectStorageBackend & { close(): void | Promise<void> };
}

export interface ActivationDatabase {
  readonly deployment: string;
  readonly version: string;
  readonly metadataNamespace: string;
  readonly db: Awaited<ReturnType<typeof connectDatabase>>["db"];
  readonly connectionString: string;
}
