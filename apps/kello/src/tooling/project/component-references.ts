import { componentPackageName } from "./component-package";
import type { BunPlugin } from "bun";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { contractGraph } from "../codegen/contracts";
import type { ContractModule } from "../codegen/contracts";

export interface ComponentSourceScope {
  readonly index: number;
  readonly mountPath: string;
  readonly namespace: string;
  readonly setupFile: string;
  readonly directory: string;
  readonly schemaFile: string | undefined;
  readonly relationsFile: string | undefined;
  readonly cronsFile?: string | undefined;
  readonly storageFile?: string | undefined;
  readonly rateLimitsFile?: string | undefined;
  readonly contractModules: readonly ContractModule[];
  readonly procedureModules: readonly {
    readonly file: string;
    readonly path: string;
    readonly visibility: "public" | "internal";
  }[];
  readonly packageEntry?: string;
  readonly bindings?: ReadonlyMap<string, string>;
  builders: readonly string[];
}

export function componentVirtual(scope: ComponentSourceScope, part: string): string {
  return `loom-component:${scope.index}:${part}`;
}

export function componentSchemaSource(scope: ComponentSourceScope): string {
  return scope.schemaFile
    ? `import declaration from ${JSON.stringify(`loom-component-file:${scope.index}:${scope.schemaFile}`)}; import { bindSchemaNamespace } from "kello/server"; export default bindSchemaNamespace(declaration, ${JSON.stringify(scope.namespace)});`
    : 'import { defineSchema } from "kello/server"; export default defineSchema(() => ({}));';
}

export function componentContractSource(scope: ComponentSourceScope): string {
  return `import schema from ${JSON.stringify(componentVirtual(scope, "schema"))};
import relations from ${JSON.stringify(componentVirtual(scope, "relations"))};
import { createProjectContext } from "kello/server";
import { resolveContract } from "kello/contract";
const { validators } = createProjectContext(schema, relations);
${scope.contractModules.map((module, index) => `import declaration${index} from ${JSON.stringify(componentVirtual(scope, `contract-source-${index}`))}; export const contract${index} = resolveContract(declaration${index}, { validators });`).join("\n")}
export const contract = ${contractGraph(scope.contractModules, (index) => `contract${index}`)};`;
}

export function componentRpcSource(scope: ComponentSourceScope): string {
  return `import component from ${JSON.stringify(scope.setupFile)};
import schema from ${JSON.stringify(componentVirtual(scope, "schema"))};
import relations from ${JSON.stringify(componentVirtual(scope, "relations"))};
import { contract } from ${JSON.stringify(componentVirtual(scope, "contracts"))};
import { createComponentRpc } from "kello/server";
export const builders = createComponentRpc(component, { schema, relations, contract });
${scope.builders.map((key, index) => `const builder${index} = builders[${JSON.stringify(key)}]; export { builder${index} as ${key} };`).join("\n")}`;
}

function generatedReference(scope: ComponentSourceScope, filename: string) {
  const published = scope.bindings?.get(filename);
  if (published)
    return { path: published === "setup" ? "setup" : componentVirtual(scope, published), namespace: "loom-component" };
  if (filename === join(scope.directory, "_generated/setup")) return { path: "setup", namespace: "loom-component" };
  for (const part of ["rpc", "server", "contract", "schema"])
    if (filename === join(scope.directory, "_generated", part))
      return {
        path: componentVirtual(scope, part === "schema" ? "schema-bindings" : part),
        namespace: "loom-component",
      };
  if (["api", "internal"].some((name) => filename === join(scope.directory, "_generated", name)))
    throw new Error("Component procedures cannot import generated client bindings");
  const index = scope.contractModules.findIndex(
    (module) => filename === join(scope.directory, "_generated/contracts", module.path.replace(/\.[cm]?[jt]s$/, "")),
  );
  if (index >= 0) return { path: componentVirtual(scope, `contract-${index}`), namespace: "loom-component" };
}

export function componentReferences(
  setupFiles: readonly string[],
  scopes: readonly ComponentSourceScope[] = [],
): BunPlugin {
  return {
    name: "loom-component-references",
    setup(build) {
      const packages = scopes.filter((scope) => scope.packageEntry);
      const packageEntries = packages.flatMap((scope) => [scope.setupFile, scope.packageEntry!]);
      if (packageEntries.length) {
        const filter = new RegExp(
          `^(?:${packageEntries.map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
        );
        build.onResolve({ filter }, async ({ path, importer }) => {
          const { resolveSync } = await import("bun");
          const filename = isAbsolute(path) ? path : resolveSync(path, dirname(importer.replace(/^\d+:/, "")));
          const canonical = await realpath(filename);
          const scope = packages.find((entry) => entry.setupFile === canonical);
          return scope ? { path: scope.setupFile, external: true } : undefined;
        });
      }
      const sourcePath = (scope: ComponentSourceScope, file: string) => `${scope.index}:${file}`;
      build.onResolve({ filter: /^(?:\.{1,2}\/|(?:@[^/]+\/)?[^/:]+(?:\/|$))/ }, async ({ path, importer }) => {
        if (!/^\d+:/.test(importer)) return;
        const separator = importer.indexOf(":");
        const scope = scopes.find((entry) => String(entry.index) === importer.slice(0, separator));
        if (!scope) throw new Error("Unknown component source instance");
        const directory = dirname(importer.slice(separator + 1));
        if (path.startsWith(".")) {
          const reference = generatedReference(scope, resolve(directory, path).replace(/\.[cm]?[jt]s$/, ""));
          if (reference) return reference;
        }
        const { resolveSync } = await import("bun");
        const resolved = resolveSync(path, directory);
        const reference = generatedReference(scope, resolved.replace(/\.[cm]?[jt]s$/, ""));
        if (reference) return reference;
        const selfImport =
          scope.packageEntry && componentPackageName(path) === componentPackageName(scope.packageEntry);
        if (!path.startsWith(".") && !selfImport) return { path: resolved, external: true };
        if (resolved === scope.setupFile) return { path: resolved };
        if (resolved === scope.schemaFile)
          return { path: componentVirtual(scope, "schema"), namespace: "loom-component" };
        return { path: sourcePath(scope, resolved), namespace: "loom-component-source" };
      });
      build.onLoad({ filter: /.*/, namespace: "loom-component-source" }, async ({ path }) => ({
        contents: await readFile(path.slice(path.indexOf(":") + 1), "utf8"),
        loader: "ts",
      }));
      build.onResolve({ filter: /^loom-component:/ }, ({ path }) => ({ path, namespace: "loom-component" }));
      build.onResolve({ filter: /_generated\// }, ({ path, importer }) => {
        const filename = resolve(dirname(importer), path).replace(/\.[cm]?[jt]s$/, "");
        const setupFile = setupFiles.find((file) => filename === join(dirname(file), "_generated/setup"));
        if (setupFile) return { path: "setup", namespace: "loom-component" };
        const bootstrapIndex = setupFiles.findIndex((file) => filename === join(dirname(file), "_generated/server"));
        if (!scopes.length && bootstrapIndex >= 0)
          return { path: `bootstrap-server:${bootstrapIndex}`, namespace: "loom-component" };
        for (const scope of scopes) {
          const reference = generatedReference(scope, filename);
          if (reference) return reference;
        }
      });
      build.onResolve({ filter: /^loom-component-file:/ }, ({ path }) => ({
        path: path.slice("loom-component-file:".length),
        namespace: "loom-component-source",
      }));
      build.onLoad({ filter: /.*/, namespace: "loom-component" }, ({ path }) => {
        if (path === "setup") return { contents: 'export { defineComponent } from "kello/server";', loader: "js" };
        if (path.startsWith("bootstrap-server:")) {
          const setupFile = setupFiles[Number(path.slice("bootstrap-server:".length))];
          if (!setupFile) throw new Error("Unknown bootstrap component server");
          return {
            contents: `import component from ${JSON.stringify(setupFile)}; import { createProjectServices, createComponentEnvironmentAccess } from "kello/server"; export const { Database, Tables, Validators, Search } = createProjectServices(); export const env = createComponentEnvironmentAccess(() => component);`,
            loader: "js",
          };
        }
        const [, index, part] = path.split(":");
        const scope = scopes.find((entry) => String(entry.index) === index);
        if (!scope) throw new Error("Unknown component reference scope");
        const contents = (() => {
          if (part?.startsWith("contract-source-")) {
            const module = scope.contractModules[Number(part.slice(16))];
            if (!module) throw new Error("Unknown component contract module");
            return `export { default } from ${JSON.stringify(`loom-component-file:${sourcePath(scope, module.file)}`)};`;
          }
          if (part === "schema") return componentSchemaSource(scope);
          if (part === "relations")
            return scope.relationsFile
              ? `export { default } from ${JSON.stringify(`loom-component-file:${sourcePath(scope, scope.relationsFile)}`)};`
              : `import schema from ${JSON.stringify(componentVirtual(scope, "schema"))}; import { defineRelations } from "drizzle-orm"; export default defineRelations(schema.tables);`;
          if (part === "contracts") return componentContractSource(scope);
          if (part === "contract") return 'export { defineContract, oc, eventIterator } from "kello/contract";';
          if (part === "rpc") return componentRpcSource(scope);
          if (part === "schema-bindings")
            return `import schema from ${JSON.stringify(componentVirtual(scope, "schema"))}; import relations from ${JSON.stringify(componentVirtual(scope, "relations"))}; import { createProjectContext } from "kello/server"; export { schema, relations }; export const { tables, validators } = createProjectContext(schema, relations);`;
          if (part === "server")
            return `import component from ${JSON.stringify(scope.setupFile)}; import schema from ${JSON.stringify(componentVirtual(scope, "schema"))}; import relations from ${JSON.stringify(componentVirtual(scope, "relations"))}; import { createComponentEnvironmentAccess, createProjectContext, createProjectServices } from "kello/server"; export const env = createComponentEnvironmentAccess(() => component); export const {tables, validators} = createProjectContext(schema, relations); export const { Database, Tables, Validators, Search } = createProjectServices();`;
          if (part?.startsWith("contract-"))
            return `export { contract${part.slice(9)} as default } from ${JSON.stringify(componentVirtual(scope, "contracts"))};`;
          throw new Error("Unknown component reference entry");
        })();
        return { contents, loader: "js" };
      });
    },
  };
}
