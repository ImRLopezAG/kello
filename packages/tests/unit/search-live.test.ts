import { describe, expect, it } from "vite-plus/test";
import { createSearchValidators } from "../../../apps/loom/src/core/search/contract";
import { searchContractDescriptor } from "../../../apps/loom/src/core/search/metadata";
import { prepareSearchPage, finishSearchPage } from "../../../apps/loom/src/core/search/pagination";
import { oc } from "../../../apps/loom/src/core/contract/index";
import { searchSchema, searchRelations } from "../fixtures/search-schema";

const validators = createSearchValidators(searchSchema, searchRelations);
const live = validators.tasks.liveSearch({ scope: "public", columns: ["title"], order: ["title"] });
const finite = validators.tasks.search({ scope: "public", columns: ["title"], order: ["title"] });
const descriptor = searchContractDescriptor(oc.input(live.input).output(live.output));
const finiteDescriptor = searchContractDescriptor(oc.input(finite.input).output(finite.output));
if (!descriptor || !finiteDescriptor) throw new Error("Missing search descriptor");
const context = { branchId: "br-live", namespace: "app", contract: "tasks.watch", identity: null };
const key = "07".repeat(32);
const input = {
  columns: { title: true },
  orderBy: [{ field: "title", direction: "asc" }],
  limit: 2,
  loadedPages: 2,
} as const;
const rows = ["A", "B", "C", "D", "E"].map((title, i) => ({
  title,
  _id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
}));

describe("coherent live search windows", () => {
  it("rejects live-window controls at a finite contract's input boundary", async () => {
    expect((await finite.input["~standard"].validate({ limit: 2, loadedPages: 3 })).issues).toBeDefined();
    const plan = await prepareSearchPage(finiteDescriptor, { limit: 2 }, context, key);
    expect(plan.config.limit).toBe(3);
    expect(plan.limit).toBe(2);
  });
  it("rejects a loaded window beyond the root-row budget before execution", async () => {
    const small = validators.tasks.liveSearch({ scope: "public", columns: ["title"], budgets: { rows: 3 } });
    const bounded = searchContractDescriptor(oc.input(small.input).output(small.output));
    if (!bounded) throw new Error("Missing descriptor");
    await expect(prepareSearchPage(bounded, { limit: 2, loadedPages: 2 }, context, key)).rejects.toMatchObject({
      code: "QUERY_BUDGET_EXCEEDED",
    });
  });
  it("reads one bounded window and partitions it only after trimming", async () => {
    const plan = await prepareSearchPage(descriptor, input, context, key);
    expect(plan.config.limit).toBe(5);
    expect(plan.limit).toBe(4);
    const page = await finishSearchPage(plan, rows);
    expect(page.pages).toEqual([
      [{ title: "A" }, { title: "B" }],
      [{ title: "C" }, { title: "D" }],
    ]);
    expect(page.rows).toBeUndefined();
    expect(page.nextCursor).toBeTypeOf("string");
    expect(page.previousCursor).toBeNull();
    expect(await plan.codec.read(page.nextCursor!, "forward")).toEqual(["D", rows[3]!._id]);
  });
  it("shrinks terminal and empty windows without padding display pages", async () => {
    const plan = await prepareSearchPage(descriptor, input, context, key);
    expect((await finishSearchPage(plan, rows.slice(0, 3))).pages).toEqual([
      [{ title: "A" }, { title: "B" }],
      [{ title: "C" }],
    ]);
    expect(await finishSearchPage(plan, [])).toEqual({ pages: [], nextCursor: null, previousCursor: null });
  });
  it("keeps live anchors stable when increasing loaded pages and rejects finite tokens", async () => {
    const plan = await prepareSearchPage(descriptor, input, context, key);
    const page = await finishSearchPage(plan, rows);
    const enlarged = await prepareSearchPage(
      descriptor,
      { ...input, loadedPages: 3, anchor: page.nextCursor },
      context,
      key,
    );
    expect(enlarged.limit).toBe(6);
    const wrong = await prepareSearchPage(
      finiteDescriptor,
      { columns: { title: true }, orderBy: input.orderBy, limit: 2 },
      context,
      key,
    );
    const finitePage = await finishSearchPage(wrong, rows.slice(0, 3));
    await expect(
      prepareSearchPage(descriptor, { ...input, anchor: finitePage.nextCursor }, context, key),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
});
