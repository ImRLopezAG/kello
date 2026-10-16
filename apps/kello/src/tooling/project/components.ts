import { componentPackageName } from "./component-package";
import { componentNamespace } from "./component-namespace";
import { sourceFiles } from "./sources";
import { componentVirtual } from "./component-references";
import type { ComponentSourceScope } from "./component-references";
import { readdir, lstat, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { getComponentPackage } from "kello/server";
import type { ComponentGraph } from "kello/server";
import type { ComponentPackageDescriptor } from "../../core/server/components/package";
import type { InferOutput } from "valibot";
import type { moduleNamespace } from "../codegen/procedures";

/** Source discovery never mounts a definition. Registration remains app-owned. */
export async function componentSetupFiles(backend: string): Promise<readonly string[]> {
  const directory = join(backend, "components");
  const state = await lstat(directory).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  });
  if (!state) return [];
  if (!state.isDirectory()) throw new Error("Component directory must be a regular directory");
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    if (entry.isSymbolicLink()) throw new Error("Component discovery does not follow symlinks");
    if (entry.isDirectory()) files.push(join(directory, entry.name, "setup.ts"));
    else if (entry.isFile() && entry.name.endsWith(".setup.ts")) files.push(join(directory, entry.name));
  }
  for (const file of files) {
    if (!(await lstat(file)).isFile()) throw new Error("Component setup must be a regular file");
  }
  return files.sort();
}

export function componentSetupSource(files: readonly string[]): string {
  return files
    .map((file, index) => `export { default as componentSetup${index} } from ${JSON.stringify(file)};`)
    .join("\n");
}

export async function resolveComponentSources(
  backend: string,
  files: readonly string[],
  exports: InferOutput<typeof moduleNamespace>,
  graph: ComponentGraph,
) {
  const { resolveSync } = await import("bun");
  const resolvedParents = new Map<string, string>();
  const sources = [];
  for (const node of graph.nodes) {
    const index = files.findIndex((_, candidate) => exports[`componentSetup${candidate}`] === node.definition);
    const descriptor = getComponentPackage(node.definition);
    const parentPath = node.path.split("/").slice(0, -1).join("/");
    const parentDirectory = dirname(resolvedParents.get(parentPath) ?? join(backend, "app.config.ts"));
    const setupFile = descriptor ? await realpath(resolveSync(descriptor.entry, parentDirectory)) : files[index];
    if (!setupFile) throw new Error(`Mounted component has no setup entry in components/: ${node.path}`);
    resolvedParents.set(node.path, setupFile);
    sources.push(
      Object.freeze({
        ...node,
        packageDescriptor: descriptor,
        setupFile,
        directory: dirname(setupFile),
        sourcePath: relative(backend, setupFile),
      }),
    );
  }
  return sources;
}

export async function componentSourceScopes(
  nodes: readonly {
    readonly setupFile: string;
    readonly path: string;
    readonly packageDescriptor?: ComponentPackageDescriptor | undefined;
  }[],
) {
  const { resolveSync } = await import("bun");
  const scopes: ComponentSourceScope[] = [];
  const resolvedEntries = new Map<string, string>();
  for (const [index, node] of nodes.entries()) {
    const { setupFile, path } = node;
    const directory = dirname(setupFile);
    if (node.packageDescriptor) {
      const descriptor = node.packageDescriptor;

      const resolvePublished = (specifier: string) => {
        if (componentPackageName(specifier) !== componentPackageName(descriptor.entry))
          throw new Error("Component descriptor entries must belong to their declaring package");
        const key = `${directory}\0${specifier}`;
        const cached = resolvedEntries.get(key);
        if (cached) return cached;
        const resolved = resolveSync(specifier, directory);
        resolvedEntries.set(key, resolved);
        return resolved;
      };
      resolvePublished(descriptor.contractRegistry);
      const bindings = new Map<string, string>();
      for (const part of ["setup", "rpc", "server", "schema", "contract"] as const) {
        const entry = descriptor.bindings[part];
        if (entry)
          bindings.set(
            resolvePublished(entry).replace(/\.[cm]?[jt]s$/, ""),
            part === "schema" ? "schema-bindings" : part,
          );
      }
      for (const [path, entry] of Object.entries(descriptor.bindings.contracts ?? {})) {
        const contract = descriptor.contracts.findIndex((module) => module.path === path);
        if (contract < 0) throw new Error(`Unknown component contract binding: ${path}`);
        bindings.set(resolvePublished(entry).replace(/\.[cm]?[jt]s$/, ""), `contract-${contract}`);
      }
      scopes.push({
        index,
        mountPath: path,
        namespace: componentNamespace(path),
        setupFile,
        directory,
        packageEntry: descriptor.entry,
        schemaFile: descriptor.schema ? resolvePublished(descriptor.schema) : undefined,
        relationsFile: descriptor.relations ? resolvePublished(descriptor.relations) : undefined,
        cronsFile: descriptor.crons ? resolvePublished(descriptor.crons) : undefined,
        storageFile: descriptor.storage ? resolvePublished(descriptor.storage) : undefined,
        rateLimitsFile: descriptor.rateLimits ? resolvePublished(descriptor.rateLimits) : undefined,
        contractModules: descriptor.contracts.map((module) => ({
          file: resolvePublished(module.entry),
          path: module.path,
        })),
        procedureModules: descriptor.procedures.map((module) => ({
          file: resolvePublished(module.entry),
          path: module.path,
          visibility: module.visibility,
        })),
        bindings,
        builders: [],
      });
      continue;
    }
    const optionalFile = async (name: string) => {
      const path = join(directory, name);
      return lstat(path).then(
        (entry) => {
          if (!entry.isFile()) throw new Error(`Component source must be a regular file: ${name}`);
          return path;
        },
        (cause: unknown) => {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
          throw cause;
        },
      );
    };
    const optionalSources = async (name: string) =>
      sourceFiles(directory, join(directory, name)).catch((cause: unknown) => {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
        throw cause;
      });
    const contractFiles = await optionalSources("contracts");
    const publicFiles = await optionalSources("functions");
    const internalFiles = await optionalSources("internal");
    scopes.push({
      index,
      mountPath: path,
      namespace: componentNamespace(path),
      setupFile,
      directory,
      schemaFile: await optionalFile("schema.ts"),
      relationsFile: await optionalFile("relations.ts"),
      cronsFile: await optionalFile("crons.ts"),
      storageFile: await optionalFile("storage.ts"),
      rateLimitsFile: await optionalFile("rate-limits.ts"),
      contractModules: contractFiles.map((file) => ({
        file,
        path: relative(join(directory, "contracts"), file).replaceAll("\\", "/"),
      })),
      procedureModules: [
        ...publicFiles.map((file) => ({
          file,
          path: relative(join(directory, "functions"), file).replaceAll("\\", "/"),
          visibility: "public" as const,
        })),
        ...internalFiles.map((file) => ({
          file,
          path: relative(join(directory, "internal"), file).replaceAll("\\", "/"),
          visibility: "internal" as const,
        })),
      ],
      builders: [],
    });
  }
  return scopes;
}

export function componentBundleSource(scopes: readonly ComponentSourceScope[]): string {
  return scopes
    .map(
      (
        scope,
      ) => `export { default as componentSchema${scope.index} } from ${JSON.stringify(componentVirtual(scope, "schema"))};
export { default as componentRelations${scope.index} } from ${JSON.stringify(componentVirtual(scope, "relations"))};
export { contract as componentContract${scope.index} } from ${JSON.stringify(componentVirtual(scope, "contracts"))};
${scope.cronsFile ? `export { default as componentCrons${scope.index} } from ${JSON.stringify(`loom-component-file:${scope.index}:${scope.cronsFile}`)};` : ""}
${scope.storageFile ? `export { default as componentStorage${scope.index} } from ${JSON.stringify(`loom-component-file:${scope.index}:${scope.storageFile}`)};` : ""}
${scope.rateLimitsFile ? `export { default as componentRateLimits${scope.index} } from ${JSON.stringify(`loom-component-file:${scope.index}:${scope.rateLimitsFile}`)};` : ""}
${scope.procedureModules.map((module, index) => `export * as component${scope.index}Module${index} from ${JSON.stringify(`loom-component-file:${scope.index}:${module.file}`)};`).join("\n")}`,
    )
    .join("\n");
}
