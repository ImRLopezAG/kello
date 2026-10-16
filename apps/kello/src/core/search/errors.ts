import * as v from "valibot";

/** Native errors available for `.errors(searchErrors)` on public search contracts. */
export const searchErrors = {
  INVALID_SELECTION: { message: "Invalid search selection" },
  INVALID_CURSOR: { message: "Restart this search", data: v.object({ restart: v.literal(true) }) },
  QUERY_BUDGET_EXCEEDED: { message: "Search exceeds its configured budget" },
} as const;
