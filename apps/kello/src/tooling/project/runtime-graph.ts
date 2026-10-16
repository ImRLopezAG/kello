import { componentDependencies } from "./component-dependencies";
import type { loadProject } from "./load";

/** Runtime projection for development and installed-package integration runners. */
export function projectRuntimeGraph(project: Awaited<ReturnType<typeof loadProject>>) {
  const scopes = new Map(project.componentScopes.map((scope) => [scope.mountPath, scope]));
  return {
    authScopes: project.authScopes.map(({ mountPath, namespace, fingerprint }) => ({
      mountPath,
      namespace,
      fingerprint,
    })),
    procedures: [
      ...project.procedures.map((entry) => ({
        path: entry.path,
        visibility: entry.visibility,
        procedure: entry.definition,
      })),
      ...project.componentScopes.flatMap((scope) =>
        scope.procedures.map((entry) => ({
          scope: scope.mountPath,
          path: entry.path,
          visibility: entry.visibility === "internal" ? ("internal" as const) : ("exported" as const),
          procedure: entry.definition,
        })),
      ),
    ],
    scopes: ["", ...project.components.map((node) => node.path)].map((name) => {
      const scope = scopes.get(name);
      const common = {
        name,
        dependencies: Object.fromEntries(
          [...componentDependencies(project.components, name)].map(([alias, target]) => [alias, target.path]),
        ),
      };
      if (!scope) return common;
      return { ...common, schema: scope.schema, crons: scope.crons, storage: scope.storage };
    }),
    exposures: project.components.flatMap((node) =>
      node.public === undefined ? [] : [{ scope: node.path, prefix: node.public }],
    ),
  };
}
