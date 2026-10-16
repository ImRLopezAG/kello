import { Procedure as NativeProcedure } from "@orpc/server";
import type { AnyProcedure } from "@orpc/server";
import type { AnyRelations } from "drizzle-orm";
import * as v from "valibot";
import { isNativeRelations } from "../database/relations";

interface LiveDependencies {
  readonly graph: AnyRelations;
  readonly tables: readonly string[];
}

const declarations = new WeakMap<AnyProcedure, LiveDependencies>();

function register(procedure: AnyProcedure, declaration: LiveDependencies): void {
  if (!(procedure instanceof NativeProcedure) || !v.is(v.function(), procedure["~orpc"].handler))
    throw new Error("Expected a completed native procedure");
  const existing = declarations.get(procedure);
  if (existing) {
    if (
      existing.graph !== declaration.graph ||
      existing.tables.length !== declaration.tables.length ||
      existing.tables.some((table, index) => table !== declaration.tables[index])
    )
      throw new Error("Conflicting live dependencies declaration");
    return;
  }
  declarations.set(procedure, declaration);
}

/** Declare all additional tracked reads in the owned invocation transaction,
 * including middleware and transforms. Wrap the completed procedure last:
 * native derivations are undeclared. Omission is unknown; [] declares no extra reads.
 * Mandatory generated-search dependencies remain additive. */
export function withLiveDependencies<Graph extends AnyRelations, Procedure extends AnyProcedure>(
  graph: Graph,
  dependencies: readonly (keyof Graph & string)[],
  procedure: Procedure,
): Procedure {
  if (!isNativeRelations(graph)) throw new Error("Expected native PostgreSQL relations");
  const tables = [...new Set(v.parse(v.array(v.string()), dependencies))].sort();
  for (const table of tables) {
    if (!Object.hasOwn(graph, table)) throw new Error(`Unknown live dependency table: ${table}`);
  }
  register(procedure, Object.freeze({ graph, tables: Object.freeze(tables) }));
  return procedure;
}

/** Private runtime binding seam; application metadata is never a declaration. */
export function getLiveDependencies(procedure: AnyProcedure): LiveDependencies | undefined {
  return declarations.get(procedure);
}

/** Carry only at canonical runtime clones; native authored derivations do not inherit. */
export function carryLiveDependencies(source: AnyProcedure, target: AnyProcedure): void {
  const declaration = declarations.get(source);
  if (declaration) register(target, declaration);
}
