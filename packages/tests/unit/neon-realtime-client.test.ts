import { expect, test, vi } from "vite-plus/test";
import * as v from "valibot";
import type {
  LiveQuerySnapshot,
  MaterializedLiveQuerySubscription,
  RealtimeClient,
  SealedLiveQuery,
} from "@neon/realtime/client";
import { createNeonLiveClient } from "../../../apps/loom/src/core/client/realtime";
import type { IssuedNeonQuery, NeonMutationResult, NeonObservation } from "../../../apps/loom/src/core/client/realtime";

type Row = { id: string; title: string };
const scope = { database: "test", deployment: "test" };
const issued: IssuedNeonQuery<Row> = {
  version: 1,
  scope,
  authorization: "auth",
  sessionExpiresAt: Date.now() + 3600_000,
  query: { capability: "sealed", queryFingerprint: "list", expiresAt: Date.now() + 60_000 },
};
const receipt: NeonMutationResult<number> = {
  version: 1,
  scope,
  authorization: "auth",
  transaction: { kind: "committed", txid: "123" },
  value: 1,
};
const rows = v.array(v.strictObject({ id: v.string(), title: v.string() }));
function fixture(initial = issued, refresh = async () => initial) {
  let snapshot: LiveQuerySnapshot<Row> = { status: "live", data: [], error: undefined };
  const changes = new Set<(value: LiveQuerySnapshot<Row>) => void>();
  const waits = new Set<{
    resolve: () => void;
    reject: () => void;
    txid: string;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const applied = new Set<string>();
  let disposed = 0;
  const wire: MaterializedLiveQuerySubscription<Row> = {
    getSnapshot: () => snapshot,
    getState: () => snapshot,
    onChange(listener) {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
    onUpdate: () => () => {},
    onStateChange: () => () => {},
    awaitRows: async () => {},
    renew: async (_query: SealedLiveQuery<Row>) => {},
    awaitTxId(txid, timeout = 10) {
      if (applied.has(txid)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const entry = {
          txid,
          resolve: () => {
            clearTimeout(entry.timer);
            waits.delete(entry);
            resolve();
          },
          reject: () => {
            clearTimeout(entry.timer);
            waits.delete(entry);
            reject(new Error("closed/timeout"));
          },
          timer: setTimeout(() => entry.reject(), timeout),
        };
        waits.add(entry);
      });
    },
    unsubscribe() {
      disposed++;
      for (const entry of Array.from(waits)) entry.reject();
      changes.clear();
    },
  };
  const sdk: RealtimeClient = { subscribe: () => wire, close: () => {} };
  const observations: NeonObservation[] = [];
  const owner = createNeonLiveClient({ url: "ws://unused", observe: (event) => observations.push(event) }, sdk);
  const live = owner.open(initial, { rows, refresh });
  return {
    owner,
    live,
    observations,
    wire,
    get disposed() {
      return disposed;
    },
    get waits() {
      return waits.size;
    },
    publish(data: readonly Row[], txid: string) {
      snapshot = { status: "live", error: undefined, data };
      for (const listener of changes) listener(snapshot);
      applied.add(txid);
      for (const entry of Array.from(waits)) if (entry.txid === txid) entry.resolve();
    },
    state(status: "connecting" | "live") {
      snapshot = { ...snapshot, status, error: undefined };
      for (const listener of changes) listener(snapshot);
    },
  };
}
test("confirmation follows installed rows in both response/delivery orders", async () => {
  const f = fixture();
  const pending = f.live.confirm(receipt, 100);
  f.publish([{ id: "1", title: "changed" }], "123");
  expect(await pending).toBe("confirmed");
  expect(f.live.getSnapshot().data?.[0]?.title).toBe("changed");
  expect(await f.live.confirm(receipt, 100)).toBe("confirmed");
  f.owner.dispose();
});
test("other writer cannot confirm; scope/session mismatch, timeout and disconnect are unknown", async () => {
  const f = fixture();
  const pending = f.live.confirm(receipt, 5);
  f.publish([], "124");
  expect(await pending).toBe("unknown");
  expect(await f.live.confirm({ ...receipt, authorization: "old-session" }, 5)).toBe("unknown");
  expect(await f.live.confirm({ ...receipt, scope: { ...scope, database: "other" } }, 5)).toBe("unknown");
  const disconnected = f.live.confirm(receipt, 100);
  f.state("connecting");
  expect(await disconnected).toBe("unknown");
  f.owner.dispose();
  expect(f.waits).toBe(0);
});
test("overlapping waits are bounded and disposal settles each observation once", async () => {
  const f = fixture();
  const pending = Array.from({ length: 32 }, () => f.live.confirm(receipt, 1000));
  expect(await f.live.confirm(receipt, 1000)).toBe("unknown");
  f.owner.dispose();
  expect(await Promise.all(pending)).toEqual(Array(32).fill("unknown"));
  expect(f.waits).toBe(0);
  expect(f.disposed).toBe(1);
  expect(f.observations.filter((event) => event.type === "confirmation")).toHaveLength(33);
});
test("invalid decoded data cannot confirm; no-write is explicit and observations cannot throw", async () => {
  const f = fixture();
  expect(await f.live.confirm({ ...receipt, transaction: { kind: "no-write" } }, 5)).toBe("no-write");
  const pending = f.live.confirm(receipt, 100);
  // @ts-expect-error Deliberately malformed transport data; the declared schema must refuse it.
  f.publish([{ id: "1", title: 12 }], "123");
  expect(await pending).toBe("unknown");
  expect(f.disposed).toBe(1);
  f.owner.dispose();
});

test("expired or overlong capabilities are rejected before subscribing", () => {
  let subscriptions = 0;
  const owner = createNeonLiveClient(
    { url: "ws://unused" },
    {
      subscribe() {
        subscriptions++;
        throw new Error("not reached");
      },
      close() {},
    },
  );
  expect(() => owner.open({ ...issued, sessionExpiresAt: 1 }, { rows, refresh: async () => issued })).toThrow(
    "session",
  );
  expect(() =>
    owner.open(
      { ...issued, sessionExpiresAt: Date.now() + 10, query: { ...issued.query, expiresAt: Date.now() + 1000 } },
      { rows, refresh: async () => issued },
    ),
  ).toThrow("session");
  expect(subscriptions).toBe(0);
  owner.dispose();
});

test("renewal authorization/fingerprint changes close the subscription and pending confirmation", async () => {
  vi.useFakeTimers();
  try {
    for (const next of [
      { ...issued, authorization: "another-session" },
      { ...issued, query: { ...issued.query, queryFingerprint: "other-query" } },
      { ...issued, sessionExpiresAt: issued.sessionExpiresAt + 1000 },
    ]) {
      const initial = { ...issued, query: { ...issued.query, expiresAt: Date.now() + 60_000 } };
      const f = fixture(initial, async () => next);
      const pending = f.live.confirm(receipt, 100_000);
      await vi.advanceTimersByTimeAsync(51_000);
      expect(await pending).toBe("unknown");
      expect(f.live.getSnapshot().status).toBe("closed");
      expect(f.disposed).toBe(1);
      expect(f.waits).toBe(0);
      f.owner.dispose();
    }
  } finally {
    vi.useRealTimers();
  }
});

test("SDK completion after verified expiry is unknown even before the expiry timer runs", async () => {
  vi.useFakeTimers();
  try {
    const initial = {
      ...issued,
      sessionExpiresAt: Date.now() + 70_000,
      query: { ...issued.query, expiresAt: Date.now() + 60_000 },
    };
    const f = fixture(initial);
    const pending = f.live.confirm(receipt, 100_000);
    // Move wall time only: deliberately do not run expiry/renewal timers.
    vi.setSystemTime(initial.sessionExpiresAt + 1);
    f.publish([{ id: "1", title: "late" }], "123");
    expect(await pending).toBe("unknown");
    expect(f.live.getSnapshot().status).toBe("closed");
    expect(f.waits).toBe(0);
    f.owner.dispose();
  } finally {
    vi.useRealTimers();
  }
});
