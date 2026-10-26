import { expect, test } from "vite-plus/test";
import { discoverProcedures } from "kello-cli";
import { createProjectProcedures, defineSchema } from "kello/server";

const { procedure } = createProjectProcedures(defineSchema(() => ({})));
const list = procedure.handler(() => []);

test("native discovery includes explicit procedures and routers, with separate internal routes", () => {
  const result = discoverProcedures([
    { path: "tasks.ts", visibility: "public", exports: { list, helper: () => "private" } },
    { path: "admin.ts", visibility: "internal", exports: { router: { tasks: { list } } } },
  ]);
  expect(result.map(({ path, visibility }) => [path, visibility])).toEqual([
    [["admin", "tasks", "list"], "internal"],
    [["tasks", "list"], "public"],
  ]);
  expect(result[0]?.exportPath).toEqual(["router", "tasks", "list"]);
});

test("native discovery rejects collisions and non-procedure router leaves", () => {
  expect(() =>
    discoverProcedures([
      { path: "tasks.ts", visibility: "public", exports: { list } },
      { path: "tasks.js", visibility: "public", exports: { router: { list } } },
    ]),
  ).toThrow("Duplicate");
  expect(() =>
    discoverProcedures([{ path: "tasks.ts", visibility: "public", exports: { router: { helper: () => "private" } } }]),
  ).toThrow("tasks.helper");
  expect(() =>
    discoverProcedures([{ path: "tasks.ts", visibility: "public", exports: { router: { constructor: list } } }]),
  ).toThrow("Invalid");
});
