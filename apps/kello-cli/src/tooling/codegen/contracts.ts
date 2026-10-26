import { ProcedureContract } from "@orpc/contract";
import type { RouterContract, AnyProcedureContract } from "@orpc/contract";
import { getDatabasePolicy } from "kello/server";
import type { DiscoveredProcedure } from "./procedures";
import { assertSegment } from "./procedures";

export interface ContractModule {
  readonly file: string;
  readonly path: string;
}

/** A contract filename owns its route prefix; contracts/internal owns server-only routes. */
export function contractGraph(modules: readonly ContractModule[], value: (index: number) => string): string {
  interface Node {
    children: Map<string, Node>;
    index?: number;
  }
  const root: Node = { children: new Map() };
  for (const [index, module] of modules.entries()) {
    const segments = module.path.replace(/\.(?:[cm]?[jt]s)$/, "").split("/");
    let node = root;
    for (const segment of segments) {
      assertSegment(segment);
      if (node.index !== undefined) throw new Error(`Contract path collision: ${module.path}`);
      const child = node.children.get(segment) ?? { children: new Map<string, Node>() };
      node.children.set(segment, child);
      node = child;
    }
    if (node.index !== undefined || node.children.size) throw new Error(`Contract path collision: ${module.path}`);
    node.index = index;
  }
  const emit = (node: Node): string =>
    node.index !== undefined
      ? value(node.index)
      : `{ ${[...node.children].map(([key, child]) => `${JSON.stringify(key)}: ${emit(child)}`).join(", ")} }`;
  return emit(root);
}

export function assertContractImplementations(
  contract: RouterContract,
  procedures: readonly DiscoveredProcedure[],
): void {
  const leaves = new Map<string, AnyProcedureContract>();
  function visit(node: RouterContract, path: readonly string[]) {
    if (node instanceof ProcedureContract) {
      leaves.set(path.join("."), node);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      assertSegment(key);
      visit(child, [...path, key]);
    }
  }
  visit(contract, []);
  for (const entry of procedures) {
    if (entry.visibility === "public" && entry.path[0] === "internal")
      throw new Error("Public procedures cannot implement internal contracts");
    const path = [...(entry.visibility === "internal" ? ["internal"] : []), ...entry.path].join(".");
    const declared = leaves.get(path)?.["~orpc"];
    if (!declared) throw new Error(`Procedure has no contract: ${path}`);
    const implemented = entry.definition["~orpc"];
    if (
      declared.inputSchemas !== implemented.inputSchemas ||
      declared.outputSchemas !== implemented.outputSchemas ||
      declared.errorMap !== implemented.errorMap ||
      declared.meta !== implemented.meta
    )
      throw new Error(`Procedure does not implement its declared contract: ${path}`);
    if (getDatabasePolicy(entry.definition) !== "automatic")
      throw new Error(`Procedure must use the application's generated RPC builder: ${path}`);
    leaves.delete(path);
  }
  if (leaves.size) throw new Error(`Missing contract implementations: ${[...leaves.keys()].join(", ")}`);
}
