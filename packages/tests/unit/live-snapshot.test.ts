import { expect, test, vi } from "vite-plus/test";
import { drizzle } from "drizzle-orm/node-postgres";
import * as v from "valibot";
import { defineSchema } from "../../../apps/kello/src/core/schema/define-schema";
import { createDependencyRegistry } from "../../../apps/kello/src/core/server/realtime/dependencies";
import type { RevisionReader } from "../../../apps/kello/src/core/server/realtime/revisions";
import {
  acceptSnapshotAttempt,
  evaluateSnapshot,
  markSnapshotUnknown,
  registerSnapshotSegment,
  runSnapshotAttempt,
} from "../../../apps/kello/src/core/server/rpc/snapshot";

const key = (namespace: string, table = "task_items") => JSON.stringify([namespace, table]);
const scopes = ["app_root", "app_left", "app_right"].map((namespace) => ({
  scope: namespace,
  schema: defineSchema((f) => ({ taskItems: { title: f.text() } }), { namespace }),
}));

// The real registry and revision reader execute SQL against deterministic persisted rows.
// This fixture supplies database rows, never collector/candidate return behavior.
function fixture() {
  const rows = new Map(scopes.map(({ scope }, i) => [key(scope), String(9007199254740993n + BigInt(i))]));
  const reads: string[][] = [];
  const db = drizzle.mock();
  const nativeExecute = db.execute.bind(db);
  vi.spyOn(db, "execute").mockImplementation((query) => {
    const result = nativeExecute(query);
    vi.spyOn(result, "execute").mockImplementation(async () => {
      const [namespace, ...tables] = v.parse(v.tupleWithRest([v.string()], v.string()), result.getQuery().params);
      reads.push(tables.map((table) => key(namespace, table)));
      const selectedRows = tables.flatMap((table) => {
        const revision = rows.get(key(namespace, table));
        return revision === undefined ? [] : [{ table_name: table, revision }];
      });
      return {
        command: "SELECT",
        rowCount: selectedRows.length,
        oid: 0,
        fields: [],
        rows: selectedRows,
      };
    });
    return result;
  });
  const registry = createDependencyRegistry("loom_test", scopes);
  return { db, registry, rows, reads };
}

test("attempt unions declared and compiler keys across mounts and preserves private absent evidence", async () => {
  const { db, registry, reads } = fixture();
  const value = { tasks: ["native"] };
  const result = await evaluateSnapshot(async () => {
    const candidate = await runSnapshotAttempt(db, registry, true, async () => {
      const root = registerSnapshotSegment({ registry, keys: [key("app_root")] });
      const child = registerSnapshotSegment({ registry, keys: [key("app_left")] });
      root([key("app_root"), key("app_left")], true);
      child([key("app_left")], true);
      return value;
    });
    expect(candidate).not.toHaveProperty("confirmationEvidence");
    acceptSnapshotAttempt(candidate);
    return candidate.value;
  });
  expect(result.value).toBe(value);
  expect(result.revisions).toEqual({ [key("app_root")]: "9007199254740993", [key("app_left")]: "9007199254740994" });
  expect(result.revisions).not.toHaveProperty(key("app_right"));
  expect(result).not.toHaveProperty("confirmationEvidence");
  expect(value).toEqual({ tasks: ["native"] });
  expect(reads).toHaveLength(2);
  expect(Object.isFrozen(result.revisions)).toBe(true);
});

test.each(["unknown declaration", "incomplete compiler", "unfinished segment", "unknown handler", "production"])(
  "%s captures every registered scope and unknown stays sticky",
  async (reason) => {
    const { db, registry, reads } = fixture();
    const result = await evaluateSnapshot(async () => {
      const candidate = await runSnapshotAttempt(db, registry, reason !== "production", async () => {
        const capture = registerSnapshotSegment({ registry, keys: reason === "unknown declaration" ? undefined : [] });
        if (reason === "incomplete compiler") capture([], false);
        if (reason === "unknown handler") markSnapshotUnknown();
        if (reason !== "unfinished segment") capture([key("app_root")], true);
        registerSnapshotSegment({ registry, keys: [] })([key("app_left")], true);
        return "value";
      });
      acceptSnapshotAttempt(candidate);
      return candidate.value;
    });
    expect(Object.keys(result.revisions).sort()).toEqual(registry.keys);
    expect(reads).toHaveLength(3);
  },
);

test("complete selective captures require a dependency while empty broad registries remain valid", async () => {
  const { db, registry, reads } = fixture();
  await expect(
    evaluateSnapshot(async () => {
      const candidate = await runSnapshotAttempt(db, registry, true, async () => {
        registerSnapshotSegment({ registry, keys: [] })([], true);
        return "invalid empty selection";
      });
      acceptSnapshotAttempt(candidate);
      return candidate.value;
    }),
  ).rejects.toThrow(/selective.*dependency/i);
  expect(reads).toEqual([]);
  const empty = createDependencyRegistry("loom_empty", []);
  const broad = await evaluateSnapshot(async () => {
    const candidate = await runSnapshotAttempt(db, empty, false, async () => "broad");
    acceptSnapshotAttempt(candidate);
    return candidate.value;
  });
  expect(broad).toEqual({ value: "broad", revisions: {} });
});

test("failed work and final revision reads discard attempts before a clean retry", async () => {
  const { db, registry, rows } = fixture();
  const result = await evaluateSnapshot(async () => {
    await expect(
      runSnapshotAttempt(db, registry, true, async () => {
        registerSnapshotSegment({ registry, keys: [key("app_right")] })([], true);
        markSnapshotUnknown();
        throw new Error("failed work");
      }),
    ).rejects.toThrow("failed work");
    rows.delete(key("app_left"));
    await expect(
      runSnapshotAttempt(db, registry, true, async () => {
        registerSnapshotSegment({ registry, keys: [key("app_left")] })([], true);
      }),
    ).rejects.toThrow(/Missing tracked/);
    const candidate = await runSnapshotAttempt(db, registry, true, async () => {
      registerSnapshotSegment({ registry, keys: [key("app_root")] })([], true);
      return "retry";
    });
    acceptSnapshotAttempt(candidate);
    return candidate.value;
  });
  expect(result.revisions).toEqual({ [key("app_root")]: "9007199254740993" });
});

test("acceptance rejects fabricated and copied candidates without contaminating the evaluation", async () => {
  const { db, registry } = fixture();
  await evaluateSnapshot(async () => {
    expect(() => acceptSnapshotAttempt({ revisions: { fabricated: "0" } })).toThrow(/own|candidate/i);
    const candidate = await runSnapshotAttempt(db, registry, false, async () => "native");
    expect(() => acceptSnapshotAttempt({ ...candidate })).toThrow(/own|candidate/i);
    acceptSnapshotAttempt(candidate);
    expect(() => acceptSnapshotAttempt(candidate)).toThrow(/one|accepted/i);
    return candidate.value;
  });
});

test("candidates cannot cross evaluations, including a failed evaluation or non-live invocation", async () => {
  const { db, registry } = fixture();
  let candidate: Awaited<ReturnType<typeof runSnapshotAttempt>> | undefined;
  await expect(
    evaluateSnapshot(async () => {
      candidate = await runSnapshotAttempt(db, registry, false, async () => "discarded");
      throw new Error("transaction rejected");
    }),
  ).rejects.toThrow("transaction rejected");
  expect(() => acceptSnapshotAttempt(candidate!)).toThrow(/inactive|evaluation|own/i);
  await evaluateSnapshot(async () => {
    expect(() => acceptSnapshotAttempt(candidate!)).toThrow(/evaluation|own/i);
    const own = await runSnapshotAttempt(db, registry, false, async () => "own");
    acceptSnapshotAttempt(own);
    return own.value;
  });
  const nonLive = await runSnapshotAttempt(db, registry, false, async () => "nonlive");
  expect(nonLive).toEqual({ value: "nonlive" });
  acceptSnapshotAttempt(nonLive);
  await expect(evaluateSnapshot(async () => acceptSnapshotAttempt(nonLive))).rejects.toThrow(/own|candidate/i);
});

test("a new transaction attempt supersedes an unaccepted candidate from a rejected transaction", async () => {
  const { db, registry } = fixture();
  const result = await evaluateSnapshot(async () => {
    const rejected = await runSnapshotAttempt(db, registry, true, async () => {
      registerSnapshotSegment({ registry, keys: [] })([key("app_right")], true);
      return "commit rejected";
    });
    // The database boundary retries without accepting the rejected transaction.
    const successful = await runSnapshotAttempt(fixture().db, registry, true, async () => {
      expect(() => acceptSnapshotAttempt(rejected)).toThrow(/owning attempt/);
      registerSnapshotSegment({ registry, keys: [] })([key("app_root")], true);
      return "committed";
    });
    expect(() => acceptSnapshotAttempt(rejected)).toThrow(/owning attempt/);
    acceptSnapshotAttempt(successful);
    await expect(runSnapshotAttempt(db, registry, false, async () => "extra")).rejects.toThrow(
      /one owning transaction/,
    );
    return successful.value;
  });
  expect(result).toEqual({ value: "committed", revisions: { [key("app_root")]: "9007199254740993" } });
});

test("acceptance preserves structural candidates with optional future evidence but rejects replacement revisions", async () => {
  const { db, registry } = fixture();
  const result = await evaluateSnapshot(async () => {
    const candidate = await runSnapshotAttempt(db, registry, false, async () => ({ native: true }));
    const revisions = candidate.revisions;
    if (!revisions) throw new Error("Expected completed snapshot revisions");
    candidate.revisions = { forged: "0" };
    expect(() => acceptSnapshotAttempt(candidate)).toThrow(/owning attempt's snapshot revisions/);
    candidate.revisions = revisions;
    const extended = Object.assign(candidate, { confirmationEvidence: { future: "opaque" } });
    acceptSnapshotAttempt(extended);
    return extended.value;
  });
  expect(result.value).toEqual({ native: true });
  expect(result).not.toHaveProperty("confirmationEvidence");
});

test("parallel transaction attempts in one evaluation are rejected until finalization settles", async () => {
  const { db } = fixture();
  const { promise: reading, resolve: entered } = Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  await evaluateSnapshot(async () => {
    const pending = runSnapshotAttempt(db, undefined, false, async () => {
      registerSnapshotSegment({
        reader: async () => {
          entered();
          await gate;
          return { tasks: "1" };
        },
      });
      return "native";
    });
    await reading;
    try {
      await expect(
        runSnapshotAttempt(fixture().db, undefined, false, async () => {
          registerSnapshotSegment({ reader: async () => ({ other: "2" }) });
        }),
      ).rejects.toThrow(/second transaction/);
    } finally {
      release();
      await pending;
    }
    const candidate = await pending;
    acceptSnapshotAttempt(candidate);
    return "native";
  });
});

test("escaped evaluation contexts cannot accept candidates or start another owning transaction", async () => {
  const { db, registry } = fixture();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  let escaped!: Promise<void>;
  await evaluateSnapshot(async () => {
    const candidate = await runSnapshotAttempt(db, registry, false, async () => "native");
    escaped = gate.then(async () => {
      expect(() => acceptSnapshotAttempt(candidate)).toThrow(/inactive/);
      await expect(runSnapshotAttempt(db, registry, false, async () => "late")).rejects.toThrow(/inactive/);
    });
    acceptSnapshotAttempt(candidate);
    return candidate.value;
  });
  release();
  await escaped;
});

test("revision finalization closes registration before the reader completes", async () => {
  const { db } = fixture();
  let capture!: ReturnType<typeof registerSnapshotSegment>;
  const result = await evaluateSnapshot(async () => {
    const candidate = await runSnapshotAttempt(db, undefined, false, async () => {
      capture = registerSnapshotSegment({
        reader: async () => {
          expect(() => capture([key("app_right")], true)).toThrow(/inactive/);
          expect(() => markSnapshotUnknown()).toThrow(/inactive/);
          return { [key("app_root")]: "9" };
        },
      });
      return "native";
    });
    acceptSnapshotAttempt(candidate);
    return candidate.value;
  });
  expect(result.revisions).toEqual({ [key("app_root")]: "9" });
});

test("segment callbacks reject another transaction, evaluation, generation and post-lifetime use", async () => {
  const { db, registry } = fixture();
  let stale: ReturnType<typeof registerSnapshotSegment> | undefined;
  await evaluateSnapshot(async () => {
    const candidate = await runSnapshotAttempt(db, registry, true, async () => {
      stale = registerSnapshotSegment({ registry, keys: [] });
      expect(() => registerSnapshotSegment({ registry: fixture().registry, keys: [] })).toThrow(/generation/);
      await expect(runSnapshotAttempt(fixture().db, registry, true, async () => null)).rejects.toThrow(
        /second transaction/,
      );
      await expect(
        evaluateSnapshot(async () => {
          expect(() => stale!([], true)).toThrow(/different evaluation/);
          throw new Error("nested evaluation stopped");
        }),
      ).rejects.toThrow("nested evaluation stopped");
      stale([key("app_root")], true);
      return "first";
    });
    expect(() => stale!([], true)).toThrow(/inactive/);
    acceptSnapshotAttempt(candidate);
    return candidate.value;
  });
  expect(() => stale!([], true)).toThrow(/inactive/);
  await evaluateSnapshot(async () => {
    const candidate = await runSnapshotAttempt(db, registry, true, async () => {
      expect(() => stale!([key("app_right")], true)).toThrow(/inactive/);
      registerSnapshotSegment({ registry, keys: [] })([key("app_left")], true);
      return "second";
    });
    acceptSnapshotAttempt(candidate);
    return candidate.value;
  });
});

test("escaped invocation contexts cannot register or mark unknown after completion", async () => {
  const { db, registry } = fixture();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  let escaped!: Promise<void>;
  await evaluateSnapshot(async () => {
    const candidate = await runSnapshotAttempt(db, registry, true, async () => {
      registerSnapshotSegment({ registry, keys: [] })([key("app_root")], true);
      escaped = gate.then(() => {
        expect(() => registerSnapshotSegment({ registry, keys: [] })).toThrow(/inactive/);
        expect(() => markSnapshotUnknown()).toThrow(/inactive/);
      });
      return "native";
    });
    acceptSnapshotAttempt(candidate);
    return candidate.value;
  });
  release();
  await escaped;
});

test("legacy readers union once per identity and reject conflicting revisions", async () => {
  const { db } = fixture();
  const reader: RevisionReader = async (transaction) => {
    expect(transaction).toBe(db);
    return { [key("app_root")]: "9" };
  };
  const result = await evaluateSnapshot(async () => {
    const candidate = await runSnapshotAttempt(db, undefined, false, async () => {
      registerSnapshotSegment({ reader });
      registerSnapshotSegment({ reader, keys: [] })([], true);
      registerSnapshotSegment({ reader: async () => ({ [key("app_left")]: "4" }) });
      return "union";
    });
    acceptSnapshotAttempt(candidate);
    return candidate.value;
  });
  expect(result.revisions).toEqual({ [key("app_root")]: "9", [key("app_left")]: "4" });
  await expect(
    evaluateSnapshot(() =>
      runSnapshotAttempt(db, undefined, false, async () => {
        registerSnapshotSegment({ reader });
        registerSnapshotSegment({ reader: async () => ({ [key("app_root")]: "10" }) });
      }),
    ),
  ).rejects.toThrow(/Conflicting/);
});
