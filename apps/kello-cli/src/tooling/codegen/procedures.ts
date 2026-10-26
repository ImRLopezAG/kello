import { Procedure } from "@orpc/server";
import type { AnyProcedure } from "@orpc/server";
import * as v from "valibot";
export const moduleNamespace = v.record(v.string(), v.unknown());

export interface ProcedureModule {
  readonly path: string;
  readonly exports: v.InferOutput<typeof moduleNamespace>;
  readonly visibility: "public" | "internal";
}
export interface DiscoveredProcedure {
  readonly path: readonly string[];
  readonly modulePath: string;
  readonly moduleIndex: number;
  readonly exportPath: readonly string[];
  readonly visibility: "public" | "internal";
  readonly definition: AnyProcedure;
}

export function assertSegment(segment: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(segment) || ["constructor", "prototype", "__proto__"].includes(segment)) {
    throw new Error(`Invalid procedure path segment: ${segment}`);
  }
}

/** Plain helper exports are ignored. Only procedure exports and explicit
 * `router`/default router exports participate in the native graph. */
export function discoverProcedures(modules: readonly ProcedureModule[]): readonly DiscoveredProcedure[] {
  const found = new Map<string, DiscoveredProcedure>();
  for (const [moduleIndex, module] of modules.entries()) {
    const segments = module.path
      .replaceAll("\\", "/")
      .replace(/\.(?:[cm]?[jt]s)$/, "")
      .split("/");
    if (segments.some((part) => part.startsWith("_") || part.startsWith("."))) continue;
    for (const segment of segments) assertSegment(segment);
    const visit = (
      value: v.InferOutput<typeof moduleNamespace>[string],
      path: string[],
      exportPath: string[],
      ancestors: Set<object>,
    ) => {
      if (value instanceof Procedure) {
        const name = `${module.visibility}:${path.join(".")}`;
        if (found.has(name)) throw new Error(`Duplicate procedure route: ${name}`);
        found.set(name, {
          path,
          modulePath: module.path,
          moduleIndex,
          exportPath,
          visibility: module.visibility,
          definition: value,
        });
        return;
      }
      if (!v.is(moduleNamespace, value) || !Object.keys(value).length)
        throw new Error(`Expected a procedure or nonempty router at ${path.join(".")}`);
      if (ancestors.has(value)) throw new Error(`Cyclic router at ${path.join(".")}`);
      ancestors.add(value);
      for (const [key, child] of Object.entries(value)) {
        assertSegment(key);
        visit(child, [...path, key], [...exportPath, key], ancestors);
      }
      ancestors.delete(value);
    };
    for (const [name, value] of Object.entries(module.exports)) {
      if (name === "router" || name === "default") {
        visit(value, segments, [name], new Set());
      } else if (value instanceof Procedure) {
        assertSegment(name);
        visit(value, [...segments, name], [name], new Set());
      }
    }
  }
  const entries = [...found.values()].sort((a, b) => a.path.join(".").localeCompare(b.path.join(".")));
  for (const entry of entries) {
    for (let length = 1; length < entry.path.length; length++) {
      if (found.has(`${entry.visibility}:${entry.path.slice(0, length).join(".")}`))
        throw new Error(`Procedure conflicts with router at ${entry.path.join(".")}`);
    }
  }
  return entries;
}
