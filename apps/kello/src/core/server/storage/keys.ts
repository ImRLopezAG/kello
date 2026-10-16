import { createHash } from "node:crypto";

export function storageKeyPrefix(projectId: string, branchId: string): string {
  const scope = createHash("sha256")
    .update(JSON.stringify([projectId, branchId]))
    .digest("hex");
  return `kello/${scope}`;
}

export function storageUploadPrefix(projectId: string, branchId: string): string {
  return `${storageKeyPrefix(projectId, branchId)}/pending/`;
}
