import assert from "node:assert/strict";
import "@orpc/effect/extensions/effect";
import { test, expect } from "bun:test";
import { call, os, ORPCError } from "@orpc/server";
import type { WithEffectContext } from "@orpc/effect";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import * as v from "valibot";

class Greeting extends Context.Service<Greeting, { prefix: string }>()("compat/Greeting") {}

const procedure = os
  .$context<WithEffectContext<Greeting>>()
  .errors({ NOT_FOUND: {} })
  .input(v.strictObject({ name: v.string() }))
  .output(v.string())
  .effect(function* ({ input, errors }) {
    const service = yield* Greeting;
    if (!input.name) return yield* Effect.fail(errors.NOT_FOUND());
    return `${service.prefix} ${input.name}`;
  });

test("native oRPC executes Effect services and preserves declared errors", async () => {
  const runtime = ManagedRuntime.make(Layer.succeed(Greeting, { prefix: "Hello" }));
  try {
    const context = { "effect/context": await runtime.context() };
    expect(await call(procedure, { name: "Kello" }, { context })).toBe("Hello Kello");
    await assert.rejects(call(procedure, { name: "" }, { context }), { code: "NOT_FOUND" });
  } finally {
    await runtime.dispose();
  }
});

test("native validation rejects invalid input before executing a handler", async () => {
  let calls = 0;
  const guarded = os.input(v.string()).handler(() => {
    calls++;
    return "done";
  });
  // @ts-expect-error Runtime validation must also reject untyped callers.
  await assert.rejects(call(guarded, 7), ORPCError);
  expect(calls).toBe(0);
});
