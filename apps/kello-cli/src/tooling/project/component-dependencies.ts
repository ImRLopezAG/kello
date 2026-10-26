import type { loadProject } from "./load";

type MountedComponent = Awaited<ReturnType<typeof loadProject>>["components"][number];
const parentPath = (path: string) => path.split("/").slice(0, -1).join("/");

/** Child mounts and explicitly bound siblings are the only reachable capabilities. */
export function componentDependencies(nodes: readonly MountedComponent[], path: string) {
  const dependencies = new Map(
    nodes.filter((node) => parentPath(node.path) === path).map((node) => [node.reference.name, node]),
  );
  const owner = nodes.find((node) => node.path === path);
  for (const [alias, reference] of Object.entries(owner?.dependencies ?? {})) {
    const target = nodes.find((node) => node.reference === reference && parentPath(node.path) === parentPath(path));
    if (!target || dependencies.has(alias)) throw new Error("Invalid component dependency binding");
    dependencies.set(alias, target);
  }
  return dependencies;
}
