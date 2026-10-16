import { AsyncLocalStorage } from "node:async_hooks";
import { AsyncIteratorClass } from "@orpc/server";
import { expect, test } from "vite-plus/test";
import * as v from "valibot";
import { createStreamLifetime } from "../../../apps/kello/src/core/server/rpc/stream-lifetime";
import { rpcOutput } from "../../../apps/kello/src/core/server/rpc/stream";

test("iterator work restores the application scope, including cancellation cleanup", async () => {
  const application = new AsyncLocalStorage<string>();
  const lifetime = createStreamLifetime();
  let cleanupScope: string | undefined;
  const source = (async function* () {
    try {
      yield application.getStore();
    } finally {
      cleanupScope = application.getStore();
    }
  })();
  const stream = await lifetime.own(v.parse(rpcOutput, source), new AbortController().signal, (work) =>
    application.run("application-a", work),
  );
  if (!(stream instanceof AsyncIteratorClass)) throw new Error("Expected native stream");
  expect(await application.run("application-b", () => stream.next())).toEqual({ done: false, value: "application-a" });
  await lifetime.stop();
  expect(cleanupScope).toBe("application-a");
  expect(await stream.next()).toEqual({ done: true, value: undefined });
});

test("shutdown drains cleanup for canceled pending reads and prevents late emissions", async () => {
  const lifetime = createStreamLifetime();
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const cleanupStarted = Promise.withResolvers<void>();
  const finishCleanup = Promise.withResolvers<void>();
  let cleaned = false;
  const source = (async function* () {
    try {
      started.resolve();
      await new Promise<void>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield "must not be delivered";
    } finally {
      cleanupStarted.resolve();
      await finishCleanup.promise;
      cleaned = true;
    }
  })();
  const stream = await lifetime.own(v.parse(rpcOutput, source), controller.signal, (work) => work());
  if (!(stream instanceof AsyncIteratorClass)) throw new Error("Expected native stream");
  const reading = stream.next();
  await started.promise;
  controller.abort();
  let stopped = false;
  const stopping = lifetime.stop().then(() => {
    stopped = true;
  });
  await cleanupStarted.promise;
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleaned).toBe(false);
    expect(stopped).toBe(false);
  } finally {
    finishCleanup.resolve();
  }
  await stopping;
  // Native cancellation closes pending reads without delivering late values.
  expect(await reading).toEqual({ done: true, value: undefined });
  expect(await stream.next()).toEqual({ done: true, value: undefined });
  expect(cleaned).toBe(true);
});

test("streams arriving after shutdown are closed before rejection", async () => {
  const lifetime = createStreamLifetime();
  await lifetime.stop();
  let closed = false;
  const source = new AsyncIteratorClass(
    async () => ({ done: false, value: "unused" }),
    async () => {
      closed = true;
    },
  );
  await expect(
    lifetime.own(v.parse(rpcOutput, source), new AbortController().signal, (work) => work()),
  ).rejects.toThrow("stopped");
  expect(closed).toBe(true);
});

test.each(["return", "completion"] as const)("shutdown drains native cleanup started by %s", async (kind) => {
  const lifetime = createStreamLifetime();
  const cleanupStarted = Promise.withResolvers<void>();
  const finishCleanup = Promise.withResolvers<void>();
  let cleaned = false;
  const source = new AsyncIteratorClass(
    async () => ({ done: kind === "completion", value: undefined }),
    async () => {
      cleanupStarted.resolve();
      await finishCleanup.promise;
      cleaned = true;
    },
  );
  const stream = await lifetime.own(v.parse(rpcOutput, source), new AbortController().signal, (work) => work());
  if (!(stream instanceof AsyncIteratorClass)) throw new Error("Expected native stream");
  const finishing = kind === "return" ? stream.return("closed") : stream.next();
  await cleanupStarted.promise;
  let stopped = false;
  const stopping = lifetime.stop().then(() => {
    stopped = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleaned).toBe(false);
    expect(stopped).toBe(false);
  } finally {
    finishCleanup.resolve();
  }
  await stopping;
  expect(await finishing).toEqual({ done: true, value: kind === "return" ? "closed" : undefined });
  expect(cleaned).toBe(true);
});
