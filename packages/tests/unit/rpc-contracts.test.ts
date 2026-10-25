import { describe, expect, test } from "vite-plus/test";
import { call, ORPCError } from "@orpc/server";
import { Context, Effect, Schema } from "effect";
import { channel } from "node:diagnostics_channel";
import { defineRelations } from "drizzle-orm";
import * as v from "valibot";
import { z } from "zod";
import {
  createProjectProcedures,
  createProjectServices,
  defineSchema,
  Invocation,
  Diagnostics,
  serializeRpcValue,
  deserializeRpcValue,
  generateRpcOpenAPI,
} from "kello/server";

const schema = defineSchema((s) => ({ tasks: { title: s.text().notNull() } }));
const { procedure } = createProjectProcedures(schema);
const invocation = { identity: null, requestId: "contracts", signal: new AbortController().signal };
const context = { ...invocation, "effect/context": Context.make(Invocation, invocation) };

describe("native project procedures", () => {
  test("injects schema bindings and infers no-input Promise and Effect handlers", async () => {
    const promise = procedure.handler(({ context }) => {
      expect(context.tables).toBe(schema.tables);
      expect(context.validators.tables.tasks.storage).toBe(schema.validators.tasks.storage);
      expect(context.validators.tables.tasks.search).toBeTypeOf("function");
      expect(context.validators.id).toBe(schema.id);
      return { table: context.tables.tasks.title.name };
    });
    const effect = procedure.effect(function* () {
      const current = yield* Invocation;
      return current.requestId;
    });
    expect(await call(promise, undefined, { context })).toEqual({ table: "title" });
    expect(await call(effect, undefined, { context })).toBe("contracts");
  });

  test("provides diagnostics inside the native Effect handler context", async () => {
    const observed: unknown[] = [];
    const metrics = channel("kello.runtime.metric");
    const collect: Parameters<typeof metrics.subscribe>[0] = (value) => {
      if (v.parse(v.object({ type: v.string() }), value).type !== "job.lease.reaped") return;
      const metric = v.parse(v.object({ type: v.literal("job.lease.reaped"), count: v.literal(0) }), value);
      observed.push(metric);
    };
    metrics.subscribe(collect);
    try {
      const item = procedure.effect(function* () {
        const publish = yield* Diagnostics;
        publish({ type: "job.lease.reaped", count: 0 });
        return "published";
      });
      expect(await call(item, undefined, { context })).toBe("published");
      expect(observed).toEqual([{ type: "job.lease.reaped", count: 0 }]);
    } finally {
      metrics.unsubscribe(collect);
    }
  });

  test("reports bounded native procedure metrics and redacted failures without retrying external work", async () => {
    const metrics = channel("kello.runtime.metric");
    const failures = channel("kello.procedure.failure");
    const observed: unknown[] = [];
    const refused: unknown[] = [];
    const collect: Parameters<typeof metrics.subscribe>[0] = (value) => {
      if (v.parse(v.object({ type: v.string() }), value).type === "rpc.procedure") observed.push(value);
    };
    const collectFailure: Parameters<typeof failures.subscribe>[0] = (value) => {
      refused.push(value);
    };
    metrics.subscribe(collect);
    failures.subscribe(collectFailure);
    let calls = 0;
    try {
      const success = procedure.handler(({ context }) => {
        expect(Object.hasOwn(context, "db")).toBe(false);
        return context.requestId;
      });
      const defect = procedure.handler(() => {
        calls++;
        throw Object.assign(new Error("private-database-payload"), { code: "40001" });
      });
      expect(await call(success, undefined, { context })).toBe("contracts");
      await expect(call(defect, undefined, { context })).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
      });
      expect(calls).toBe(1);
      expect(observed).toEqual([
        { type: "rpc.procedure", mode: "finite", status: "success", durationMs: expect.any(Number) },
        { type: "rpc.procedure", mode: "finite", status: "error", durationMs: expect.any(Number) },
      ]);
      expect(refused).toEqual([{ requestId: "contracts", code: "INTERNAL_SERVER_ERROR" }]);
      expect(JSON.stringify([observed, refused])).not.toContain("private-database-payload");
    } finally {
      metrics.unsubscribe(collect);
      failures.unsubscribe(collectFailure);
    }
  });

  test("native transforms validate input and output without losing their types", async () => {
    let calls = 0;
    const item = procedure
      .input(v.pipe(v.string(), v.transform(Number), v.number()))
      .output(
        v.pipe(
          v.number(),
          v.transform((n) => ({ value: n })),
        ),
      )
      .handler(({ input }) => {
        calls++;
        return input + 1;
      });
    expect(await call(item, "41", { context })).toEqual({ value: 42 });
    await expect(call(item, "bad", { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(calls).toBe(1);
  });

  test("provides generated table and validator services to Effect handlers", async () => {
    const relations = defineRelations(schema.tables);
    const { Tables, Validators } = createProjectServices<typeof schema, typeof relations>();
    const item = procedure.effect(function* () {
      const tables = yield* Tables;
      const validators = yield* Validators;
      const descriptor = validators.tasks.search({ scope: "public", columns: ["title"] });
      const selected = yield* Effect.promise(() =>
        Promise.resolve(descriptor.input["~standard"].validate({ columns: { title: true } })),
      );
      return {
        table: tables.tasks.title.name,
        sharedValidators: validators.tasks.storage === schema.validators.tasks.storage,
        search: !selected.issues,
      };
    });
    expect(await call(item, undefined, { context })).toEqual({ table: "title", sharedValidators: true, search: true });
  });

  test("declared errors survive Effect while unexpected defects are redacted", async () => {
    const known = procedure.errors({ NOT_FOUND: {} }).effect(function* ({ errors }) {
      return yield* Effect.fail(errors.NOT_FOUND({ message: "Task missing" }));
    });
    const defect = procedure.effect(function* () {
      return yield* Effect.die(new Error("postgres://private-password"));
    });
    const undeclared = procedure.handler(() => {
      throw new ORPCError("BAD_REQUEST", { message: "secret" });
    });
    const declaredDefect = procedure.errors({ NOT_FOUND: {} }).effect(function* ({ errors }) {
      return yield* Effect.die(errors.NOT_FOUND({ message: "secret defect" }));
    });
    await expect(call(known, undefined, { context })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Task missing",
    });
    for (const item of [defect, undeclared, declaredDefect]) {
      await expect(call(item, undefined, { context })).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
      });
    }
  });

  test("project ID validators reject malformed IDs without claiming existence", async () => {
    const item = procedure.input(schema.id("tasks")).handler(({ input }) => input);
    const missing = "b04fe8a3-2c1d-4d97-8f03-e96244cc9b70";
    expect(await call(item, missing, { context })).toBe(missing);
    await expect(call(item, "invalid", { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("native RPC preserves dates, bigint, undefined and null", () => {
    const value = { date: new Date("2026-09-24T00:00:00Z"), count: 99n, empty: null, absent: undefined };
    expect(deserializeRpcValue(serializeRpcValue(value))).toEqual(value);
  });

  test("beta.46 preserves persisted beta.43 mutation result bytes", () => {
    const value = {
      date: new Date("2026-09-24T00:00:00Z"),
      count: 99n,
      empty: null,
      absent: undefined,
      url: new URL("https://example.com/"),
      set: new Set(["a"]),
      map: new Map([["a", 1]]),
    };
    // Captured with beta.43 before upgrading; persisted replay rows must remain readable.
    const previous = {
      json: {
        date: "2026-09-24T00:00:00.000Z",
        count: "99",
        empty: null,
        absent: null,
        url: "https://example.com/",
        set: ["a"],
        map: [["a", 1]],
      },
      meta: [
        ["date", "date"],
        ["bigint", "count"],
        ["undefined", "absent"],
        ["url", "url"],
        ["set", "set"],
        ["map", "map"],
      ],
    };
    expect(JSON.stringify(serializeRpcValue(value))).toBe(JSON.stringify(previous));
    expect(deserializeRpcValue(JSON.parse(JSON.stringify(previous)))).toEqual(value);
  });

  test("finite outputs reject values that JSON would silently discard", async () => {
    interface Cyclic {
      self?: Cyclic;
    }
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    for (const value of [() => "lost", Symbol("lost"), { callback: () => 1 }, cyclic, new Date(NaN)]) {
      // @ts-expect-error Untyped callers must also fail at the serialization boundary.
      expect(() => serializeRpcValue(value)).toThrow();
      await expect(
        call(
          procedure.handler(() => value),
          undefined,
          { context },
        ),
      ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    }
  });

  test("OpenAPI names unsupported procedures and requires explicit output contracts", async () => {
    const typed = procedure.output(v.object({ title: v.string() })).handler(() => ({ title: "task" }));
    const doc = await generateRpcOpenAPI({ tasks: { list: typed } });
    expect(doc.paths?.["/tasks/list"]?.post?.operationId).toBe("tasks.list");
    await expect(generateRpcOpenAPI({ tasks: { inferred: procedure.handler(() => "hello") } })).rejects.toThrow(
      "tasks.inferred",
    );
    const unsupported = procedure.output(v.custom<string>(() => true)).handler(() => "hello");
    await expect(generateRpcOpenAPI({ tasks: { unsupported } })).rejects.toThrow("tasks.unsupported");
    const effect = procedure.output(Schema.toStandardSchemaV1(Schema.String)).handler(() => "typed");
    expect((await generateRpcOpenAPI({ tasks: { effect } })).paths?.["/tasks/effect"]).toBeDefined();
  });

  test("OpenAPI supports Standard JSON Schema contracts without requiring a Zod runtime dependency", async () => {
    const item = procedure
      .input(z.object({ name: z.string() }))
      .output(z.object({ message: z.string() }))
      .handler(({ input }) => ({ message: input.name }));
    const doc = await generateRpcOpenAPI({ hello: item });
    expect(doc.paths?.["/hello"]?.post?.responses?.["200"]).toMatchObject({
      content: {
        "application/json": {
          schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
        },
      },
    });
    const unsupported = procedure.output(z.custom<string>(() => true)).handler(() => "value");
    await expect(generateRpcOpenAPI({ unsupported })).rejects.toThrow("unsupported");
  });
});
