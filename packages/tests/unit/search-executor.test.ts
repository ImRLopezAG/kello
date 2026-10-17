import { describe, it, expect } from "vite-plus/test";
import { createSearchContext, validateSelectedSearchOutput } from "../../../apps/kello/src/core/search/executor";
import { createSearchValidators } from "../../../apps/kello/src/core/search/contract";
import { oc } from "../../../apps/kello/src/core/contract/index";
import { searchSchema, searchRelations } from "../fixtures/search-schema";
import { searchContractDescriptor } from "../../../apps/kello/src/core/search/metadata";

const validators = { tables: createSearchValidators(searchSchema, searchRelations) };
const search = validators.tables.tasks.search({ scope: "public", columns: ["title", "done"] });
const descriptor = searchContractDescriptor(oc.input(search.input).output(search.output));
if (!descriptor) throw new Error("Missing search descriptor");

describe("invocation-bound search", () => {
  it("reports declared nested-row and encoded-result budget errors", () => {
    for (const budgets of [{ rows: 2 }, { resultBytes: 128 }]) {
      const selection = validators.tables.tasks.search({
        scope: "public",
        columns: ["title"],
        through: { taskLabels: "public" },
        relations: { labels: { scope: "public", columns: ["name"] } },
        budgets,
      });
      const bounded = searchContractDescriptor(oc.input(selection.input).output(selection.output));
      if (!bounded) throw new Error("Missing descriptor");
      const input = { columns: { title: true }, with: { labels: { columns: { name: true } } } };
      const page = {
        rows: [{ title: "A".repeat(256), labels: [{ name: "one" }, { name: "two" }] }],
        nextCursor: null,
        previousCursor: null,
      };
      expect(() => validateSelectedSearchOutput(bounded, input, page)).toThrowError(
        expect.objectContaining({ code: "QUERY_BUDGET_EXCEEDED" }),
      );
    }
  });
  it("reports preflight traversal exhaustion without inspecting the remaining output", () => {
    const selection = validators.tables.tasks.search({ scope: "public", columns: ["title"], budgets: { rows: 2 } });
    const bounded = searchContractDescriptor(oc.input(selection.input).output(selection.output));
    if (!bounded) throw new Error("Missing descriptor");
    const page = { rows: Array.from({ length: 100 }, () => ({ title: "A" })), nextCursor: null, previousCursor: null };
    expect(() => validateSelectedSearchOutput(bounded, { columns: { title: true } }, page)).toThrowError(
      expect.objectContaining({ code: "QUERY_BUDGET_EXCEEDED" }),
    );
  });
  it("rejects escaped calls before database acquisition", async () => {
    const context = createSearchContext(searchRelations);
    // Runtime caller has no validated invocation, regardless of structurally valid input.
    const input = await search.input["~standard"].validate({});
    if (input.issues) throw new Error("Invalid fixture input");
    expect(() => context.tasks.paginate(input.value)).toThrow("active search");
  });
  it("validates a manual result against the exact selection and preserves count strings", () => {
    const input = { columns: { title: true }, count: true };
    const page = { rows: [{ title: "visible" }], count: "9007199254740993", nextCursor: null, previousCursor: null };
    expect(validateSelectedSearchOutput(descriptor, input, page)).toBe(page);
    for (const invalid of [
      { ...page, rows: [{ title: "visible", done: false }] },
      { ...page, rows: [{ title: 1 }] },
      { ...page, rows: [{}] },
      { ...page, count: 9007199254740992 },
      { ...page, count: undefined },
    ])
      expect(() => validateSelectedSearchOutput(descriptor, input, invalid)).toThrow("selected search");
  });
  it("rejects missing fields and wrong nested cardinality without running the executor", () => {
    const selection = validators.tables.tasks.search({
      scope: "public",
      columns: ["title"],
      relations: {
        project: { scope: "public", columns: ["name"] },
      },
    });
    const nested = searchContractDescriptor(oc.input(selection.input).output(selection.output));
    if (!nested) throw new Error("Missing descriptor");
    const input = { with: { project: {} } };
    const page = { rows: [{ title: "visible", project: { name: "Project" } }], nextCursor: null, previousCursor: null };
    expect(validateSelectedSearchOutput(nested, input, page)).toBe(page);
    for (const project of [[], { name: 2 }, { name: "Project", private: "secret" }])
      expect(() =>
        validateSelectedSearchOutput(nested, input, { ...page, rows: [{ title: "visible", project }] }),
      ).toThrow("selected search");
  });
});
