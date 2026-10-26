import { createHash } from "node:crypto";

/** Physical identity depends only on the canonical mount path, never source placement. */
export function componentNamespace(path: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)*$/.test(path))
    throw new Error("Invalid canonical component path");
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 24);
  return `cmp_${path.replaceAll("/", "_").toLowerCase().slice(0, 34)}_${hash}`;
}
