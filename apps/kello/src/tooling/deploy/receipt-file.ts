import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export async function writeReceiptFile(
  directory: string,
  name:
    | "functions.json"
    | "release.json"
    | "branch.json"
    | "baseline.json"
    | "onboarding.json"
    | "project.json"
    | ".env"
    | ".env.local",
  contents: string,
): Promise<void> {
  const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, name));
    const folder = await open(directory, "r");
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
