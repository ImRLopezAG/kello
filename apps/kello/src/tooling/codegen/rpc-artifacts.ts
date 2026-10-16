import { componentDependencies } from "../project/component-dependencies";
import { relative } from "node:path";
import type { loadProject } from "../project/load";
import type { DiscoveredProcedure } from "./procedures";

interface RouterNode {
  readonly children: Map<string, RouterNode>;
  leaf?: DiscoveredProcedure;
}

function graph(entries: readonly DiscoveredProcedure[], types: boolean): string {
  const root: RouterNode = { children: new Map() };
  for (const entry of entries) {
    let node = root;
    for (const segment of entry.path) {
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.leaf = entry;
  }
  function emit(node: RouterNode): string {
    if (node.leaf) {
      const access = node.leaf.exportPath.map((key) => `[${JSON.stringify(key)}]`).join("");
      return types ? `typeof m${node.leaf.moduleIndex}${access}` : `project.module${node.leaf.moduleIndex}${access}`;
    }
    return `{ ${[...node.children].map(([key, child]) => `${JSON.stringify(key)}: ${emit(child)}`).join(types ? "; " : ", ")} }`;
  }
  return emit(root);
}

/** Runtime client code contains no project imports; declarations alone refer to
 * the native procedure types. Internal routes are emitted only in server code. */
export function rpcArtifacts(project: Awaited<ReturnType<typeof loadProject>>, directory: string) {
  const publicEntries = project.procedures.filter((entry) => entry.visibility === "public");
  const internalEntries = project.procedures.filter((entry) => entry.visibility === "internal");
  const declarations = (entries: readonly DiscoveredProcedure[]) => {
    const indices = [...new Set(entries.map((entry) => entry.moduleIndex))];
    return indices
      .map((index) => {
        const source = project.procedureModules[index];
        if (!source) throw new Error("Discovered procedure module is missing");
        const path = relative(directory, source.file)
          .replaceAll("\\", "/")
          .replace(/\.(?:[cm]?[jt]s)$/, "");
        return `import type * as m${index} from ${JSON.stringify(path.startsWith(".") ? path : `./${path}`)};`;
      })
      .join("\n");
  };
  const componentEntries = project.components.flatMap((node) => {
    const scope = project.componentScopes.find((entry) => entry.mountPath === node.path);
    if (!scope) throw new Error("Missing component source scope");
    return scope.procedures.map(
      (entry) =>
        `{ scope: ${JSON.stringify(node.path)}, path: ${JSON.stringify(entry.path)}, visibility: ${JSON.stringify(entry.visibility === "internal" ? "internal" : "exported")}, procedure: project.component${scope.index}Module${entry.moduleIndex}${entry.exportPath.map((key) => `[${JSON.stringify(key)}]`).join("")} }`,
    );
  });
  const scopeDeclarations = ["", ...project.components.map((node) => node.path)].map((name) => ({
    name,
    dependencies: Object.fromEntries(
      [...componentDependencies(project.components, name)].map(([alias, target]) => [alias, target.path]),
    ),
  }));
  return {
    "internal.js": 'export { internal } from "./router.js";\n',
    "internal.d.ts": `${declarations(internalEntries)}\nexport declare const internal: ${graph(internalEntries, true)};\n`,
    "router.js": `import * as project from "./project.js";
import { defineRpcAuth, defineProcedureStorage } from "kello/server";
export { schema, relations, crons, upgrade as jobMigrations } from "./project.js";
export { application } from "./project.js";
export const auth = project.auth ?? defineRpcAuth();
export const storage = project.storage ?? defineProcedureStorage();
export const router = ${graph(publicEntries, false)};
export const internal = ${graph(internalEntries, false)};
export const scopes = ${JSON.stringify(scopeDeclarations)}.map(scope => ({ ...scope, ...({ ${project.componentScopes.map((scope) => `${JSON.stringify(scope.mountPath)}: { schema: project.componentSchema${scope.index}, crons: project.componentCrons${scope.index} ?? {}, storage: project.componentStorage${scope.index} ?? defineProcedureStorage() }`).join(", ")} })[scope.name] }));
export const exposures = ${JSON.stringify(project.components.filter((node) => node.public !== undefined).map((node) => ({ scope: node.path, prefix: node.public })))};
export const procedures = [${project.procedures.map((entry) => `{ path: ${JSON.stringify(entry.path)}, visibility: ${JSON.stringify(entry.visibility)}, procedure: project.module${entry.moduleIndex}${entry.exportPath.map((key) => `[${JSON.stringify(key)}]`).join("")} }`).join(", ")}${componentEntries.length ? `, ${componentEntries.join(", ")}` : ""}];
`,
  };
}
