import { expect, test } from "vite-plus/test";
import { AsyncIteratorClass, call, eventIterator, ORPCError } from "@orpc/server";
import { Context } from "effect";
import * as v from "valibot";
import { createProjectProcedures, defineSchema, Invocation } from "kello/server";
import { rpcOutput, validateRpcOutput } from "../../../apps/kello/src/core/server/rpc/stream";

const { procedure } = createProjectProcedures(defineSchema(() => ({})));
const invocation = { identity: null, requestId: "streams", signal: new AbortController().signal };
const context = { ...invocation, "effect/context": Context.make(Invocation, invocation) };

test("native iterator contracts validate lazily and redact event validation failures", async () => {
  let consumed = 0;
  let cleaned = false;
  const route = procedure.output(eventIterator(v.number())).handler(async function* () {
    try {
      consumed++;
      yield 1;
      consumed++;
      yield Number.NaN;
    } finally {
      cleaned = true;
    }
  });
  const stream = await call(route, undefined, { context });
  expect(consumed).toBe(0);
  expect(await stream.next()).toEqual({ done: false, value: 1 });
  await expect(stream.next()).rejects.toMatchObject({
    code: "INTERNAL_SERVER_ERROR",
    message: "Internal server error",
  });
  expect(cleaned).toBe(true);
});

test("stream cancellation runs cleanup and redacts cleanup failures", async () => {
  let cleaned = false;
  const route = procedure.output(eventIterator(v.string())).handler(async function* () {
    try {
      yield "ready";
    } finally {
      cleaned = true;
      await Promise.reject(new Error("private cleanup credential"));
    }
  });
  const stream = await call(route, undefined, { context });
  await stream.next();
  await expect(stream.return()).rejects.toMatchObject({
    code: "INTERNAL_SERVER_ERROR",
    message: "Internal server error",
  });
  expect(cleaned).toBe(true);
});

test("declared stream errors keep their native contract", async () => {
  const route = procedure
    .errors({ FORBIDDEN: { message: "Access revoked" } })
    .output(eventIterator(v.string()))
    .handler(async function* ({ errors }) {
      yield "ready";
      throw errors.FORBIDDEN();
    });
  const stream = await call(route, undefined, { context });
  await stream.next();
  await expect(stream.next()).rejects.toMatchObject({ code: "FORBIDDEN", message: "Access revoked" });
});

test("finite contracts cannot smuggle an iterator through permissive schemas", async () => {
  const route = procedure.output(v.unknown()).handler(async function* () {
    yield "hidden stream";
  });
  await expect(call(route, undefined, { context })).rejects.toBeInstanceOf(ORPCError);
});

test("the result limit applies separately to every event and cleans up after rejection", async () => {
  let cleaned = false;
  const source = (async function* () {
    try {
      yield "ok";
      yield "x".repeat(2048);
    } finally {
      cleaned = true;
    }
  })();
  const stream = validateRpcOutput(v.parse(rpcOutput, source), true, 1024);
  // The wire boundary returns a union because it also handles finite calls.
  expect(stream).toHaveProperty("next");
  if (!(stream instanceof AsyncIteratorClass)) throw new Error("Expected native iterator");
  await stream.next();
  await expect(stream.next()).rejects.toThrow("configured limit");
  expect(cleaned).toBe(true);
});
