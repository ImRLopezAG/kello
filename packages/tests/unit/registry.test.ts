import { expect, test } from "vite-plus/test";
import { os } from "@orpc/server";
import { discoverProcedures } from "kello-cli";

test("discovery includes native procedures only, with deterministic routes and visibility", () => {
  const list = os.handler(() => []);
  const cleanup = os.handler(() => null);
  const entries = discoverProcedures([
    { path: "tasks.ts", visibility: "public", exports: { list, helper: () => "private" } },
    { path: "tasks.ts", visibility: "internal", exports: { cleanup } },
    { path: "_generated/ignored.ts", visibility: "public", exports: { list } },
  ]);
  expect(entries.map((entry) => [entry.path, entry.visibility])).toEqual([
    [["tasks", "cleanup"], "internal"],
    [["tasks", "list"], "public"],
  ]);
  expect(() =>
    discoverProcedures([
      { path: "tasks.ts", visibility: "public", exports: { list } },
      { path: "tasks.js", visibility: "public", exports: { list } },
    ]),
  ).toThrow("Duplicate");
});
