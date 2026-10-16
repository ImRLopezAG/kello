import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "bun:test";
import * as v from "valibot";
import { cleanupScaleFixture, cleanupScaleTransaction } from "../fixtures/search-full-text-scale-cleanup";

function barrier() {
  let open = () => {};
  const reached = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { reached, open };
}

// Offline proof of the same functions called by the native scale finally paths.
// These callbacks inject resource failures; they make no database acceptance claim.
test("U5 scale cleanup awaits every close and retains primary plus every owned cleanup failure", async () => {
  const primary = new Error("primary assertion");
  const failures = ["first close", "second close", "schema", "metadata", "role", "owner.end"].map(
    (name) => new Error(name),
  );
  const closeStarted = barrier();
  const allowClose = barrier();
  const attempts: string[] = [];
  let settled = false;
  const cleanup = cleanupScaleFixture(
    [
      {
        close: async () => {
          attempts.push("first close");
          throw failures[0];
        },
      },
      {
        close: async () => {
          attempts.push("second close started");
          closeStarted.open();
          await allowClose.reached;
          attempts.push("second close settled");
          throw failures[1];
        },
      },
    ],
    failures.slice(2).map((failure) => async () => {
      attempts.push(failure.message);
      throw failure;
    }),
    { error: primary },
  ).then(
    () => {
      settled = true;
      return undefined;
    },
    (error) => {
      settled = true;
      return v.parse(v.instance(AggregateError), error);
    },
  );
  try {
    await closeStarted.reached;
    await setImmediate();
    assert.equal(settled, false, "An early close rejection cannot complete cleanup");
    assert.deepEqual(attempts, ["first close", "second close started"]);
  } finally {
    allowClose.open();
    await cleanup;
  }
  const error = await cleanup;
  assert(error instanceof AggregateError);
  assert.equal(error.cause, primary);
  assert.deepEqual(error.errors, [primary, ...failures]);
  assert.deepEqual(attempts, [
    "first close",
    "second close started",
    "second close settled",
    "schema",
    "metadata",
    "role",
    "owner.end",
  ]);
});

test("U5 scale rollback failure destroys/releases and owns pending settlement even when release fails", async () => {
  const primary = new Error("primary oracle/blocker failure");
  const rollback = new Error("rollback");
  const release = new Error("release");
  const request = new Error("pending request");
  const released = barrier();
  const allowRequest = barrier();
  const attempts: string[] = [];
  let settled = false;
  const pending = allowRequest.reached.then(() => {
    attempts.push("request settled");
    throw request;
  });
  const cleanup = cleanupScaleTransaction(
    async () => {
      attempts.push("rollback");
      throw rollback;
    },
    (destroy) => {
      attempts.push(`release ${destroy}`);
      released.open();
      throw release;
    },
    { error: primary },
    pending,
  ).then(
    () => {
      settled = true;
      return undefined;
    },
    (error) => {
      settled = true;
      return v.parse(v.instance(AggregateError), error);
    },
  );
  try {
    await released.reached;
    await setImmediate();
    assert.equal(settled, false, "Release failure cannot abandon the pending request");
    assert.deepEqual(attempts, ["rollback", "release true"]);
  } finally {
    allowRequest.open();
    await cleanup;
  }
  const error = await cleanup;
  assert(error instanceof AggregateError);
  assert.equal(error.cause, primary);
  assert.deepEqual(error.errors, [primary, rollback, release, request]);
  assert.deepEqual(attempts, ["rollback", "release true", "request settled"]);
});

test("U5 scale successful cleanup preserves the exact primary thrown by the fixture", async () => {
  const primary = new Error("original");
  const attempts: string[] = [];
  await assert.rejects(
    async () => {
      try {
        throw primary;
      } finally {
        await cleanupScaleTransaction(
          async () => {
            attempts.push("rollback");
          },
          (destroy) => {
            assert.equal(destroy, false);
            attempts.push("release");
          },
          { error: primary },
        );
        await cleanupScaleFixture(
          [],
          [
            async () => {
              attempts.push("owner.end");
            },
          ],
          { error: primary },
        );
      }
    },
    (error) => error === primary,
  );
  assert.deepEqual(attempts, ["rollback", "release", "owner.end"]);
});

test("U5 scale cleanup failures surface without a primary error", async () => {
  const failure = new Error("owner.end");
  await assert.rejects(
    cleanupScaleFixture(
      [],
      [
        async () => {
          throw failure;
        },
      ],
      undefined,
    ),
    (cause) => {
      const error = v.parse(v.instance(AggregateError), cause);
      assert.deepEqual(error.errors, [failure]);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});
