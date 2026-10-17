import { expect, test } from "vite-plus/test";
import * as v from "valibot";
import { runtimeConfigValidator } from "../../../apps/kello/src/core/server/config";

test.each(["polling", "notify"])("runtime refuses the removed %s live engine configuration", (mode) => {
  expect(v.safeParse(runtimeConfigValidator, { realtime: { mode } }).success).toBe(false);
});

test("cloud runtime preserves ordinary HTTP and cloud job configuration", () => {
  const parsed = v.parse(runtimeConfigValidator, { openapi: true, jobs: { maxAttempts: 3 } });
  expect(parsed.openapi).toBe(true);
  expect(parsed.jobs.maxAttempts).toBe(3);
  expect(Object.hasOwn(parsed, "realtime")).toBe(false);
});

test("RPC result limits remain bounded independently of the removed live engine", () => {
  expect(v.parse(runtimeConfigValidator, {}).rpc.maxResultBytes).toBe(1_048_576);
  expect(v.parse(runtimeConfigValidator, { rpc: { maxResultBytes: 1024 } }).rpc.maxResultBytes).toBe(1024);
  for (const maxResultBytes of [1023, 10_485_761, Infinity, 1024.5]) {
    expect(v.safeParse(runtimeConfigValidator, { rpc: { maxResultBytes } }).success).toBe(false);
  }
});

import { createSearchContext } from "../../../apps/kello/src/core/search/executor";
import { createSearchValidators } from "../../../apps/kello/src/core/search/contract";
import { searchSchema, searchRelations } from "../fixtures/search-schema";

test("generated search retains pagination without the retired watch engine", () => {
  const context = createSearchContext(searchRelations);
  const validators = createSearchValidators(searchSchema, searchRelations);
  expect(context.tasks.paginate).toBeTypeOf("function");
  expect(Object.hasOwn(context.tasks, "watch")).toBe(false);
  expect(validators.tasks.search).toBeTypeOf("function");
  expect(Object.hasOwn(validators.tasks, "liveSearch")).toBe(false);
});

import { sql } from "drizzle-orm";
import { oc } from "../../../apps/kello/src/core/contract/index";
import { searchContractDescriptor } from "../../../apps/kello/src/core/search/metadata";
import { compileSearch } from "../../../apps/kello/src/core/search/compiler";

test("search refuses retired dependency declarations and live window budgets", () => {
  const validators = createSearchValidators(searchSchema, searchRelations);
  const retired = { dependencies: [] };
  expect(() =>
    validators.tasks.search({
      columns: ["title"],
      scope: { name: "tenant", version: "1", where: () => sql`true`, ...retired },
    }),
  ).toThrow();
  const retiredBudget = { loadedPages: 2 };
  expect(() =>
    validators.tasks.search({
      columns: ["title"],
      scope: "public",
      budgets: { pageSize: 10, ...retiredBudget },
    }),
  ).toThrow();
});

test("finite search compilation has no legacy dependency evidence", () => {
  const validators = createSearchValidators(searchSchema, searchRelations);
  const pair = validators.tasks.search({ columns: ["title"], scope: "public" });
  const descriptor = searchContractDescriptor(oc.input(pair.input).output(pair.output));
  if (!descriptor) throw new Error("Missing search descriptor");
  const compiled = compileSearch(descriptor, {}, null);
  expect(Object.hasOwn(compiled, "dependencies")).toBe(false);
  expect(Object.hasOwn(compiled, "dependencyEvidence")).toBe(false);
});
