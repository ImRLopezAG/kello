import { createRouterClient, os } from "@orpc/server";
import { defineRelations } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import * as v from "valibot";
import { withLiveDependencies } from "../../../apps/kello/src/core/server/index";

const tasks = pgTable("tasks", { title: text().notNull() });
const permissions = pgTable("permissions", { role: text().notNull() });
const graph = defineRelations({ tasks, permissions });
const procedure = os
  .$context<{ principal: string }>()
  .input(v.object({ title: v.string() }))
  .output(v.object({ title: v.string(), principal: v.string() }))
  .handler(({ input, context }) => ({ title: input.title, principal: context.principal }));
const wrapped = withLiveDependencies(graph, ["permissions"], procedure);
const empty = withLiveDependencies(
  graph,
  [],
  os.handler(() => null),
);

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;
export type ExactNativeProcedure = Assert<Equal<typeof wrapped, typeof procedure>>;

export function checkLiveDependencyCaller() {
  const client = createRouterClient({ wrapped, empty }, { context: { principal: "alice" } });
  const result: Promise<{ title: string; principal: string }> = client.wrapped({ title: "hello" });
  const noExtraReads: Promise<null> = client.empty();
  // @ts-expect-error Local graph names reject typos.
  withLiveDependencies(graph, ["permission"], procedure);
  // @ts-expect-error SQL table objects are not graph-local declaration names.
  withLiveDependencies(graph, [permissions], procedure);
  // @ts-expect-error An incomplete native builder is not a completed procedure.
  withLiveDependencies(graph, [], os.input(v.string()));
  // @ts-expect-error Non-procedures cannot be declared.
  withLiveDependencies(graph, [], {});
  // @ts-expect-error Native caller input remains exact.
  void client.wrapped({ title: 42 });
  // @ts-expect-error Required native context remains required.
  createRouterClient({ wrapped }, { context: {} });
  return { result, noExtraReads };
}
