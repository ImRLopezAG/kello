import {
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { loadProject } from "../project/load";
import { resolveProjectPath } from "../config/paths";
import { withGenerationLock } from "./lock";
import { runtimeArtifacts } from "./runtime";
import { serverBindings } from "./server";
import { rpcArtifacts } from "./rpc-artifacts";
import { applicationArtifacts, applicationClientArtifacts } from "./application";
import { writeComponentBindings } from "./components";
import { publicProjectValidator } from "../config/resolve";
import type { PublicProjectConfiguration } from "../config/resolve";
import * as v from "valibot";

type LoadedProject = Awaited<ReturnType<typeof loadProject>>;
export interface ProcedureManifest {
  readonly format: 1;
  readonly project: string;
  readonly version: string;
  readonly schemaFingerprint: string;
  readonly protocol: "loom-orpc-2";
  readonly procedures: readonly { readonly path: readonly string[]; readonly visibility: "public" | "internal" }[];
}

async function pruneContractBindings(directory: string, expected: ReadonlySet<string>): Promise<void> {
  const state = await lstat(directory).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  });
  if (!state) return;
  if (!state.isDirectory()) throw new Error("Refusing a non-directory generated contracts path");
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filename = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Refusing a symlink in generated contract bindings");
    if (entry.isDirectory()) {
      await pruneContractBindings(filename, expected);
      if (!(await readdir(filename)).length) await rmdir(filename);
    } else if (entry.isFile() && !expected.has(filename)) {
      const content = await readFile(filename, "utf8");
      if (/^export \{ contract\d+ as default \} from "(?:\.\.\/)+contract-registry";\n$/.test(content))
        await rm(filename);
    }
  }
}

async function writeGeneration(project: LoadedProject): Promise<ProcedureManifest> {
  const generationRoot = await resolveProjectPath(
    project.root,
    relative(project.root, join(project.backend, "_generated")),
  );
  const artifactsRoot = await resolveProjectPath(project.root, ".loom/generations");
  await mkdir(artifactsRoot, { recursive: true });
  const directory = join(artifactsRoot, project.version);
  const manifest: ProcedureManifest = {
    format: 1,
    project: project.config.project,
    version: project.version,
    schemaFingerprint: project.schema.fingerprint,
    protocol: "loom-orpc-2",
    procedures: project.procedures.map(({ path, visibility }) => ({ path, visibility })),
  };
  const artifacts = {
    "project.js": project.bundle,
    "version.mjs": `export const version = ${JSON.stringify(project.version)};\n`,
    "manifest.json": JSON.stringify(manifest, null, 2) + "\n",
  };
  Object.assign(artifacts, runtimeArtifacts(project), rpcArtifacts(project, directory));
  Object.assign(artifacts, applicationClientArtifacts(project, directory));
  try {
    await mkdir(generationRoot);
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause;
    if ((await readFile(join(generationRoot, ".loom-generated"), "utf8").catch(() => "")) !== "loom-generated-v1\n") {
      // A fresh checkout may contain only committed migration history.
      const entries = await readdir(generationRoot, { withFileTypes: true });
      if (entries.some((entry) => entry.name !== "migrations" || !entry.isDirectory()))
        throw new Error(
          "Refusing to replace a user-owned _generated directory; move conflicting non-migration files aside and preserve migrations",
        );
    }
  }
  try {
    await writeFile(join(generationRoot, ".loom-generated"), "loom-generated-v1\n", { flag: "wx" });
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause;
  }
  const entrypoints = new Map([
    ["api", "createClient"],
    ["internal", "internal"],
    ["service", "createService"],
    ["worker", "createWorker"],
  ]);
  if ("react.js" in artifacts) entrypoints.set("react", "createClient");
  for (const [name, exported] of entrypoints) {
    for (const extension of ["js", "d.ts"]) {
      const filename = join(generationRoot, `${name}.${extension}`);
      const content = `export * from "./current/${name}.js";\n`;
      try {
        await writeFile(filename, content, { flag: "wx" });
      } catch (cause) {
        if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause;
        const prior = await readFile(filename, "utf8");
        if (!(await lstat(filename)).isFile()) throw new Error("Generated entry point has been modified");
        if (prior !== content) {
          const legacy = `export { ${name === "api" ? "api" : exported} } from "./current/${name}.js";\n`;
          if (prior !== legacy) throw new Error("Generated entry point has been modified");
          const replacement = `${filename}.${crypto.randomUUID()}`;
          try {
            await writeFile(replacement, content, { flag: "wx" });
            await rename(replacement, filename);
          } finally {
            await rm(replacement, { force: true });
          }
        }
      }
    }
  }
  const relationsPath = await resolveProjectPath(
    project.root,
    relative(project.root, join(project.backend, "relations.ts")),
  );
  const hasRelations = await lstat(relationsPath).then(
    () => true,
    (cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
      throw cause;
    },
  );
  const server = hasRelations
    ? 'import relations from "../relations";\nimport schema from "../schema";\n'
    : 'import { defineRelations } from "drizzle-orm";\nimport schema from "../schema";\nconst relations = defineRelations(schema.tables);\n';
  const serverPath = join(generationRoot, "server.ts");
  const existingServer = await lstat(serverPath).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  });
  if (existingServer && !existingServer.isFile())
    throw new Error("Refusing to replace a non-file generated server binding");
  await writeFile(
    serverPath,
    server +
      serverBindings(true) +
      'import app from "../app.config";\nimport { createApplicationEnvironmentAccess } from "kello/server";\nexport const env = createApplicationEnvironmentAccess(() => app);\n',
  );
  const bindings = applicationArtifacts(project, hasRelations);
  await writeComponentBindings(project);
  for (const [name, content] of Object.entries(bindings)) {
    const filename = await resolveProjectPath(project.root, relative(project.root, join(generationRoot, name)));
    await mkdir(dirname(filename), { recursive: true });
    const existing = await lstat(filename).catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
      throw cause;
    });
    if (existing && !existing.isFile()) throw new Error("Refusing to replace a non-file generated application binding");
    if (name === "config.js") {
      const temporary = `${filename}.${crypto.randomUUID()}`;
      try {
        await writeFile(temporary, content, { flag: "wx" });
        await rename(temporary, filename);
      } finally {
        await rm(temporary, { force: true });
      }
    } else await writeFile(filename, content);
  }
  await pruneContractBindings(
    join(generationRoot, "contracts"),
    new Set(Object.keys(bindings).map((name) => join(generationRoot, name))),
  );
  const staging = join(artifactsRoot, `.staging-${crypto.randomUUID()}`);
  await mkdir(staging);
  try {
    await Promise.all(
      Object.entries(artifacts).map(([name, content]) => writeFile(join(staging, name), content, { flag: "wx" })),
    );
    try {
      await rename(staging, directory);
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || !["EEXIST", "ENOTEMPTY"].includes(String(cause.code)))
        throw cause;
      for (const [name, content] of Object.entries(artifacts)) {
        if ((await readFile(join(directory, name), "utf8")) !== content)
          throw new Error("Existing generated artifacts are inconsistent with their version");
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return manifest;
}

async function activateGeneration(
  project: LoadedProject,
  signal?: AbortSignal,
  onActivated?: () => void,
): Promise<void> {
  const generationRoot = await resolveProjectPath(
    project.root,
    relative(project.root, join(project.backend, "_generated")),
  );
  const artifactsRoot = await resolveProjectPath(project.root, ".loom/generations");
  await mkdir(artifactsRoot, { recursive: true });
  const directory = join(artifactsRoot, project.version);
  const active = join(generationRoot, "current");
  try {
    const current = await lstat(active);
    if (!current.isSymbolicLink())
      throw new Error(
        "Refusing to replace a user-owned _generated directory; move conflicting non-migration files aside and preserve migrations",
      );
    const target = resolve(generationRoot, await readlink(active));
    if (![generationRoot, artifactsRoot].some((parent) => /^([a-f0-9]{64})$/.test(relative(parent, target))))
      throw new Error("Refusing to replace an unmanaged _generated link");
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
  }
  const link = join(generationRoot, `.current-${crypto.randomUUID()}`);
  try {
    await symlink(relative(generationRoot, directory), link, "dir");
    signal?.throwIfAborted();
    await rename(link, active);
    onActivated?.();
    // Retain the active version and one prior cached build; public imports never accumulate generations.
    const versions = (await readdir(artifactsRoot, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name),
    );
    const previous = versions.filter((entry) => entry.name !== project.version);
    const ordered = await Promise.all(
      previous.map(async (entry) => ({
        name: entry.name,
        time: (await stat(join(artifactsRoot, entry.name))).mtimeMs,
      })),
    );
    ordered.sort((a, b) => b.time - a.time);
    for (const entry of ordered.slice(1)) await rm(join(artifactsRoot, entry.name), { recursive: true });
    for (const entry of await readdir(generationRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
        await rm(join(generationRoot, entry.name), { recursive: true });
    }
  } finally {
    await rm(link, { force: true });
  }
}

/** Prepare an immutable candidate without changing the active references. */
export async function prepareProject(root: string): Promise<ProcedureManifest> {
  return withGenerationLock(root, async () => writeGeneration(await loadProject(root)));
}

/** Recheck source identity and artifact content under the same publication lock. */
export async function activateProject(
  root: string,
  expectedVersion: string,
  signal?: AbortSignal,
  onActivated?: () => void,
): Promise<ProcedureManifest> {
  return withGenerationLock(root, async () => {
    signal?.throwIfAborted();
    const project = await loadProject(root);
    if (project.version !== expectedVersion) throw new Error("Candidate generation is stale");
    const manifest = await writeGeneration(project);
    await assertGeneratedVersion(root, expectedVersion);
    await activateGeneration(project, signal, onActivated);
    return manifest;
  });
}

export async function generateProject(root: string): Promise<ProcedureManifest> {
  return withGenerationLock(root, async () => {
    const project = await loadProject(root);
    const manifest = await writeGeneration(project);
    await assertGeneratedVersion(root, project.version);
    await activateGeneration(project);
    return manifest;
  });
}

export async function assertGeneratedVersion(root: string, expectedVersion: string): Promise<void> {
  const project = await loadProject(root);
  if (project.version !== expectedVersion) throw new Error("Generated contracts are stale; run kello generate");
}

/** Refresh deployment coordinates without rebuilding or changing immutable release artifacts. */
export async function publishProjectConfiguration(
  root: string,
  expectedVersion: string,
  configuration: PublicProjectConfiguration,
): Promise<void> {
  const parsed = v.parse(publicProjectValidator, configuration);
  await withGenerationLock(root, async () => {
    const project = await loadProject(root);
    if (project.version !== expectedVersion) throw new Error("Release source version changed");
    const filename = await resolveProjectPath(root, `${project.config.backend}/_generated/config.js`);
    if (!(await lstat(filename)).isFile()) throw new Error("Refusing a non-file generated configuration");
    const temporary = `${filename}.${crypto.randomUUID()}`;
    try {
      await writeFile(temporary, `export const configuration = Object.freeze(${JSON.stringify(parsed)});\n`, {
        flag: "wx",
      });
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true });
    }
  });
}
