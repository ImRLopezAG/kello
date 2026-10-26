import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { beforeAll, afterAll, expect, test } from "bun:test";
import { call } from "@orpc/server";
import type { RouterClient } from "@orpc/server";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { RPCHandler } from "@orpc/server/websocket";
import { createRpcHttpApp } from "../../../apps/kello/src/core/adapters/neon/rpc-http";
import { rpcProtocolVersion } from "../../../apps/kello/src/core/server/rpc/serialization";
import { rpcTransportSerializer } from "../../../apps/kello/src/core/adapters/neon/rpc-context";
import { Context } from "effect";
import { defineRelations, sql } from "drizzle-orm";
import pg from "pg";
import * as v from "valibot";
import { defineSchema } from "../../../apps/kello/src/core/schema/define-schema";
import { connectDatabase } from "../../../apps/kello/src/core/server/database/connection";
import { createProjectProcedures } from "../../../apps/kello/src/core/server/rpc/procedure";
import { bindRpcDatabaseProcedure, createDatabaseMiddleware } from "../../../apps/kello/src/core/server/rpc/database";
import { Invocation } from "../../../apps/kello/src/core/server/effect/runtime";
import { defineRateLimits } from "../../../apps/kello/src/core/server/rate-limits/policy";
import {
  RateLimits,
  invocationRateLimits,
  withInvocationRateLimits,
} from "../../../apps/kello/src/core/server/rate-limits/service";
import type { RateLimitScope } from "../../../apps/kello/src/core/server/rate-limits/service";
import { RateLimitExceeded, RateLimitUnavailable } from "../../../apps/kello/src/core/server/rate-limits/errors";
import { bootstrapDatabase } from "../../../apps/kello-cli/src/tooling/migrations/bootstrap";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("Rate-limit acceptance requires LOOM_TEST_DATABASE_URL for disposable PostgreSQL 18");
const schema = defineSchema(() => ({}));
const relations = defineRelations(schema.tables);
const namespace = `loom_limit_fit_${crypto.randomUUID().replaceAll("-", "")}`;
const role = `${namespace}_runtime`;
const admin = new pg.Client({ connectionString });
let connection: Awaited<ReturnType<typeof connectDatabase<typeof relations>>>;
const table = sql`${sql.identifier(namespace)}.counter`;
const policies = defineRateLimits({
  write: { version: 1, mode: "quota", scope: "user", limit: 10, windowMs: 60_000 },
  abuse: { version: 1, mode: "attempt", scope: "user", limit: 10, windowMs: 60_000 },
});
const { procedure } = createProjectProcedures(schema);
const write = createDatabaseMiddleware(relations, "write", schema);
const read = createDatabaseMiddleware(relations, "read", schema);
const invocation = () => {
  const context = {
    identity: { issuer: "fit", subject: "alice" },
    signal: new AbortController().signal,
    requestId: crypto.randomUUID(),
  };
  return { ...context, idempotencyKey: crypto.randomUUID(), "effect/context": Context.make(Invocation, context) };
};
const dbOptions = () => ({
  connection,
  replay: { metadataNamespace: namespace, deployment: "rate-limit-fit" },
  authorize: async () => {},
});
let admissions = 0;
let attempts = 0;
let denied = false;
const scope: RateLimitScope = {
  definitions: policies,
  quota: async (db) => {
    admissions++;
    await db.execute(sql`UPDATE ${table} SET value = value + 1`);
    if (denied) throw new RateLimitExceeded(1501);
  },
  attempt: async () => {
    attempts++;
  },
};

beforeAll(async () => {
  await admin.connect();
  expect(Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num)).toBeGreaterThanOrEqual(
    180000,
  );
  await bootstrapDatabase({ connectionString: connectionString!, metadataNamespace: namespace, runtimeRole: role });
  await admin.query(`CREATE TABLE "${namespace}".counter (value integer NOT NULL)`);
  await admin.query(`INSERT INTO "${namespace}".counter VALUES (0)`);
  await admin.query(`GRANT SELECT, UPDATE ON "${namespace}".counter TO "${role}"`);
  await admin.query(`ALTER ROLE "${role}" LOGIN PASSWORD 'disposable-fit-only'`);
  const url = new URL(connectionString!);
  url.username = role;
  url.password = "disposable-fit-only";
  connection = await connectDatabase({ schema, relations, connectionString: url.href });
});
afterAll(async () => {
  await connection?.close();
  await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
const count = async () => Number((await admin.query(`SELECT value FROM "${namespace}".counter`)).rows[0].value);

test("attempt rejects inside direct guarded read and write transactions before admission", async () => {
  for (const accessMode of ["read only", "read write"] as const) {
    const before = attempts;
    await expect(
      withInvocationRateLimits(invocation(), scope, () =>
        connection.transaction(async () => invocationRateLimits().attemptPromise(policies, "abuse"), { accessMode }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(attempts).toBe(before);
  }
});

test("quota shares the guarded write transaction and drains unawaited work", async () => {
  const context = invocation();
  const bound = bindRpcDatabaseProcedure(
    procedure
      .use(write)
      .output(v.number())
      .handler(({ context }) => {
        void context.rateLimits.quotaPromise(policies, "write");
        return 7;
      }),
    dbOptions(),
  );
  const before = await count();
  expect(await withInvocationRateLimits(context, scope, () => call(bound, undefined, { context }))).toBe(7);
  expect(await count()).toBe(before + 1);
});

test("caught quota denial poisons business transaction and returns safe typed error", async () => {
  denied = true;
  const context = invocation();
  const bound = bindRpcDatabaseProcedure(
    procedure
      .use(write)
      .output(v.number())
      .handler(async ({ context }) => {
        await context.rateLimits.quotaPromise(policies, "write").catch(() => {});
        await context.db.execute(sql`UPDATE ${table} SET value = value + 10`);
        return 7;
      }),
    dbOptions(),
  );
  const before = await count();
  try {
    await expect(
      withInvocationRateLimits(context, scope, () => call(bound, undefined, { context })),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", data: { retryAfterMs: 1501 } });
    expect(await count()).toBe(before);
  } finally {
    denied = false;
  }
});

test("attempt rejects inside read and write invocations without acquiring its store", async () => {
  for (const middleware of [read, write]) {
    const context = invocation();
    const bound = bindRpcDatabaseProcedure(
      procedure
        .use(middleware)
        .output(v.number())
        .handler(async ({ context }) => {
          await context.rateLimits.attemptPromise(policies, "abuse");
          return 7;
        }),
      dbOptions(),
    );
    const before = attempts;
    await expect(
      withInvocationRateLimits(context, scope, () => call(bound, undefined, { context })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(attempts).toBe(before);
  }
});

test("Effect and Promise receive the same scoped service and expired handles reject", async () => {
  const context = invocation();
  let captured: ReturnType<typeof invocationRateLimits> | undefined;
  const bound = procedure.output(v.boolean()).effect(function* ({ context }) {
    const limits = yield* RateLimits;
    captured = limits;
    yield* limits.attempt(policies, "abuse");
    return limits === context.rateLimits;
  });
  expect(await withInvocationRateLimits(context, scope, () => call(bound, undefined, { context }))).toBe(true);
  await expect(captured!.attemptPromise(policies, "abuse")).rejects.toBeDefined();
});

test("unknown scope definitions fail closed and captured capabilities cannot cross invocations", async () => {
  const context = invocation();
  const other = defineRateLimits({ other: { version: 1, mode: "attempt", scope: "user", limit: 1, windowMs: 1000 } });
  let captured: ReturnType<typeof invocationRateLimits> | undefined;
  const before = attempts;
  await expect(
    withInvocationRateLimits(context, scope, async () => {
      captured = invocationRateLimits();
      await captured.attemptPromise(other, "other");
    }),
  ).rejects.toBeInstanceOf(RateLimitUnavailable);
  expect(attempts).toBe(before);
  await withInvocationRateLimits(invocation(), { ...scope, definitions: other }, async () => {
    await expect(captured!.attemptPromise(policies, "abuse")).rejects.toBeDefined();
  });
});

test("rolled-back quota admission does not poison a successful serialization retry", async () => {
  let calls = 0;
  const retryScope: RateLimitScope = {
    ...scope,
    quota: async (db) => {
      await db.execute(sql`UPDATE ${table} SET value = value + 1`);
      if (++calls === 1) throw Object.assign(new Error("serialization fixture"), { code: "40001" });
    },
  };
  const context = invocation();
  const bound = bindRpcDatabaseProcedure(
    procedure
      .use(write)
      .output(v.number())
      .handler(async ({ context }) => {
        await context.rateLimits.quotaPromise(policies, "write");
        return 7;
      }),
    dbOptions(),
  );
  const before = await count();
  expect(await withInvocationRateLimits(context, retryScope, () => call(bound, undefined, { context }))).toBe(7);
  expect(calls).toBe(2);
  expect(await count()).toBe(before + 1);
});

test("local HTTP and WebSocket preserve native limiter errors", async () => {
  const router = {
    denied: procedure.output(v.null()).handler(() => {
      throw new RateLimitExceeded(1501);
    }),
    unavailable: procedure.output(v.null()).handler(() => {
      throw new RateLimitUnavailable();
    }),
  };
  const version = "a".repeat(64);
  const http = createRpcHttpApp({
    router,
    version,
    origins: ["https://client.test"],
    allowAnonymous: true,
    verify: async () => {
      throw new Error("unused verifier");
    },
  });
  const sockets = new RPCHandler(router, { serializer: rpcTransportSerializer });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/ws" && server.upgrade(request)) return;
      return http.fetch(request);
    },
    websocket: {
      async message(socket, message) {
        await sockets.message(socket, message, { context: invocation() });
      },
      async close(socket) {
        await sockets.close(socket);
      },
    },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  try {
    const client = createORPCClient<RouterClient<typeof router>>(
      new RPCLink({ connect: () => socket, serializer: rpcTransportSerializer }),
    );
    await expect(client.denied()).rejects.toMatchObject({
      code: "RATE_LIMITED",
      data: { retryAfterMs: 1501 },
      message: "Rate limit exceeded",
    });
    await expect(client.unavailable()).rejects.toMatchObject({
      code: "RATE_LIMIT_UNAVAILABLE",
      message: "Rate limit unavailable",
    });
    for (const [name, status] of [
      ["denied", 429],
      ["unavailable", 503],
    ] as const) {
      const response = await fetch(new URL(`/api/kello/rpc/${name}`, server.url), {
        method: "POST",
        headers: { "x-loom-protocol": rpcProtocolVersion, "x-loom-version": version, origin: "https://client.test" },
      });
      expect(response.status).toBe(status);
      expect(response.headers.get("retry-after")).toBe(name === "denied" ? "2" : null);
      expect(response.headers.get("access-control-expose-headers")).toContain("Retry-After");
    }
  } finally {
    socket.close();
    await server.stop(true);
  }
});

test("replay returns the business result without charging quota again", async () => {
  const context = invocation();
  const bound = bindRpcDatabaseProcedure(
    procedure
      .use(write)
      .output(v.number())
      .handler(async ({ context }) => {
        await context.rateLimits.quotaPromise(policies, "write");
        return 7;
      }),
    dbOptions(),
  );
  const before = admissions;
  for (let repeat = 0; repeat < 2; repeat++) {
    expect(
      await withInvocationRateLimits(context, scope, () => call(bound, undefined, { context, path: ["replay"] })),
    ).toBe(7);
  }
  expect(admissions).toBe(before + 1);
});

test("read-only quota and a still-live foreign invocation capability fail closed", async () => {
  const context = invocation();
  const bound = bindRpcDatabaseProcedure(
    procedure
      .use(read)
      .output(v.number())
      .handler(async ({ context }) => {
        await context.rateLimits.quotaPromise(policies, "write");
        return 7;
      }),
    dbOptions(),
  );
  const before = admissions;
  await expect(
    withInvocationRateLimits(context, scope, () => call(bound, undefined, { context })),
  ).rejects.toMatchObject({ code: "RATE_LIMIT_UNAVAILABLE" });
  expect(admissions).toBe(before);
  const beforeAttempts = attempts;
  await expect(
    withInvocationRateLimits(context, scope, async () => {
      const captured = invocationRateLimits();
      await withInvocationRateLimits(invocation(), scope, async () => {
        await expect(captured.attemptPromise(policies, "abuse")).rejects.toBeDefined();
      });
    }),
  ).rejects.toBeDefined();
  expect(attempts).toBe(beforeAttempts);
});

test("quota refuses mismatched limiter and database invocation authorities", async () => {
  const limiterContext = invocation();
  const databaseContext = { ...invocation(), identity: { issuer: "fit", subject: "bob" } };
  const bound = bindRpcDatabaseProcedure(
    procedure
      .use(write)
      .output(v.number())
      .handler(async ({ context }) => {
        await context.rateLimits.quotaPromise(policies, "write").catch(() => {});
        await context.db.execute(sql`UPDATE ${table} SET value = value + 10`);
        return 7;
      }),
    dbOptions(),
  );
  const before = await count();
  const beforeAdmissions = admissions;
  await expect(
    withInvocationRateLimits(limiterContext, scope, () => call(bound, undefined, { context: databaseContext })),
  ).rejects.toBeDefined();
  expect(admissions).toBe(beforeAdmissions);
  expect(await count()).toBe(before);
});

test("equivalent definitions and distinct scope bindings route to their registered store", async () => {
  const bundle = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../../../apps/kello/src/core/server/rate-limits/policy.ts", import.meta.url))],
    target: "node",
  });
  expect(bundle.success).toBe(true);
  const independentPath =
    "data:text/javascript;base64," + Buffer.from(await bundle.outputs[0]!.text()).toString("base64");
  const independent: typeof import("../../../apps/kello/src/core/server/rate-limits/policy") = await import(
    independentPath
  );
  expect(independent.defineRateLimits).not.toBe(defineRateLimits);
  const equivalent = independent.defineRateLimits(policies.policies);
  const other = defineRateLimits({ other: { version: 1, mode: "attempt", scope: "user", limit: 1, windowMs: 1000 } });
  const observed: string[] = [];
  await withInvocationRateLimits(
    invocation(),
    {
      ...scope,
      attempt: async (_identity, name) => {
        observed.push(`root:${name}`);
      },
    },
    async () => {
      await invocationRateLimits().attemptPromise(equivalent, "abuse");
      await withInvocationRateLimits(
        invocation(),
        {
          ...scope,
          definitions: other,
          attempt: async (_identity, name) => {
            observed.push(`mount:${name}`);
          },
        },
        async () => {
          await invocationRateLimits().attemptPromise(other, "other");
        },
      );
      await invocationRateLimits().attemptPromise(equivalent, "abuse");
    },
  );
  expect(observed).toEqual(["root:abuse", "mount:other", "root:abuse"]);
});
