import { readFile, mkdir, rmdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { resolveProjectPath } from "./paths";
import { writeReceiptFile } from "../deploy/receipt-file";

const value = v.pipe(
  v.string(),
  v.minLength(1),
  v.check((entry) => !/[\r\n\0]/.test(entry), "Environment values must occupy one line"),
);
const url = v.pipe(
  value,
  v.url(),
  v.check((entry) => {
    const url = new URL(entry);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }),
);
const identity = v.pipe(value, v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/));
const publicEnvironment = v.strictObject({
  NEON_PROJECT_ID: v.optional(identity),
  NEON_BRANCH_ID: v.optional(identity),
  LOOM_URL: v.optional(v.nullable(url)),
  NEON_AUTH_URL: v.optional(v.nullable(url)),
});
export type ManagedPublicEnvironment = v.InferInput<typeof publicEnvironment>;

export async function withProjectConfigurationLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const directory = await resolveProjectPath(root, ".loom");
  await mkdir(directory, { recursive: true });
  const lock = join(directory, "configuration.lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error("Project configuration is locked by another operation. Inspect its receipt before retrying.");
  }
  try {
    return await operation();
  } finally {
    await rmdir(lock);
  }
}

function commentSuffix(value: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "#") return ` ${value.slice(index)}`;
  }
  if (quote) throw new Error("Refusing to rewrite a multiline or unterminated managed environment value");
  return "";
}

/** Only public project coordinates belong here; secrets remain with provider/server configuration. */
export async function writeManagedPublicEnvironment(
  root: string,
  input: ManagedPublicEnvironment,
  name: ".env" | ".env.local" = ".env.local",
): Promise<void> {
  const values = v.parse(publicEnvironment, input);
  v.parse(v.picklist([".env", ".env.local"]), name);
  if (Object.values(values).every((entry) => entry === undefined)) return;
  await withProjectConfigurationLock(root, async () => {
    const existing = await lstat(join(root, name)).catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
      throw cause;
    });
    if (existing && !existing.isFile()) throw new Error("Refusing to replace a non-file environment path");
    const path = await resolveProjectPath(root, name);
    const previous = await readFile(path, "utf8").catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return "";
      throw cause;
    });
    const newline = previous.includes("\r\n") ? "\r\n" : "\n";
    let next = previous;
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const pattern = new RegExp(`^([ \t]*(?:export[ \t]+)?${key}[ \t]*=)([^\\r\\n]*)(?=\\r?$)`, "gm");
      const matches = [...next.matchAll(pattern)];
      if (matches.length > 1) throw new Error(`Duplicate managed environment key: ${key}`);
      const match = matches[0];
      if (value === null) {
        if (match) next = next.replace(pattern, () => commentSuffix(match[2] ?? "").trimStart());
        continue;
      }
      const assignment = `${JSON.stringify(value)}${commentSuffix(match?.[2] ?? "")}`;
      if (match) next = next.replace(pattern, () => `${match[1]}${assignment}`);
      else next += `${next && !next.endsWith("\n") ? newline : ""}${key}=${assignment}${newline}`;
    }
    await writeReceiptFile(root, name, next);
  });
}
