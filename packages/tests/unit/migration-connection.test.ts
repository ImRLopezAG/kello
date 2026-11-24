import { afterEach, expect, test, vi } from "vite-plus/test";
import type { PoolConfig } from "drizzle-orm/postgres/client/node";
import {
  assertMigrationConnection,
  sessionTls,
  withMigrationConnection,
  withBlockingGinTimeout,
} from "../../../apps/kello-cli/src/tooling/migrations/connection";
import { FakeConnection, fakeCreatePool, fakePoolState, fakeSession } from "../fixtures/fake-session-driver";
import type { DriverMock, FakePoolState } from "../fixtures/fake-session-driver";

const driver = vi.hoisted((): DriverMock => ({}));
vi.mock("drizzle-orm/postgres/client/node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm/postgres/client/node")>()),
  createPool: (config: PoolConfig) => driver.createPool!(config),
}));

function install(): FakePoolState {
  const state = fakePoolState();
  driver.createPool = fakeCreatePool(state);
  return state;
}
afterEach(() => {
  delete driver.createPool;
});

const version = { rows: [{ server_version_num: "180006" }], rowCount: 1 };

test("Neon migration URLs verify the certificate and hostname whatever sslmode the URL carries", async () => {
  const state = install();
  const stopped = new Error("Connection intercepted before network access");
  state.connect = async () => {
    throw stopped;
  };
  const operation = vi.fn(async () => undefined);
  for (const query of ["", "?sslmode=require", "?sslmode=require&channel_binding=require", "?sslmode=no-verify"]) {
    await expect(
      withMigrationConnection(`postgres://migrator:secret@ep-fixture.eu.neon.tech/db${query}`, operation),
    ).rejects.toBe(stopped);
    expect(state.configs.at(-1)?.ssl).toBe("verify-full");
    expect(state.configs.at(-1)).toMatchObject({ max: 1, reconnect: false, applicationName: "kello-migrations" });
  }
  expect(operation).not.toHaveBeenCalled();
});

test("Neon URLs that disable TLS, and non-PostgreSQL URLs, are rejected before any connection opens", async () => {
  const state = install();
  for (const query of ["?sslmode=disable", "?ssl=false"])
    await expect(
      withMigrationConnection(`postgres://migrator:secret@ep-fixture.eu.neon.tech/db${query}`, async () => {}),
    ).rejects.toThrow("Neon connections require TLS");
  await expect(withMigrationConnection("https://ep-fixture.eu.neon.tech/db", async () => {})).rejects.toThrow(
    "Expected a PostgreSQL migration URL",
  );
  expect(state.configs).toHaveLength(0);
});

test("non-Neon hosts keep their sslmode reading", () => {
  const tls = (query: string) => sessionTls(new URL(`postgres://user@127.0.0.1:5432/db${query}`));
  expect(tls("")).toBe(false);
  expect(tls("?sslmode=disable")).toBe(false);
  expect(tls("?sslmode=no-verify")).toBe("require");
  for (const mode of ["require", "prefer", "verify-ca", "verify-full"])
    expect(tls(`?sslmode=${mode}`)).toBe("verify-full");
});

test("owned migration defaults remain 5s/60s and a local timeout surrounds the complete operation", async () => {
  const state = install();
  state.connection = new FakeConnection(({ sql }) =>
    sql === "SHOW server_version_num" ? version : { rows: [{ timeout: "60s" }], rowCount: 1 },
  );
  const queries = state.connection.queries;
  let owned: Parameters<typeof assertMigrationConnection>[0] | undefined;
  await withMigrationConnection("postgres://localhost/db", async (client) => {
    owned = client;
    assertMigrationConnection(client);
    const result = await withBlockingGinTimeout(client, 120000, async () => {
      await client.query("native bookkeeping and DDL fixture");
      return "complete";
    });
    expect(result).toBe("complete");
    expect(queries.map((query) => query.sql)).toEqual([
      "SHOW server_version_num",
      "SET lock_timeout = '5s'",
      "SET statement_timeout = '60s'",
      "SET search_path = pg_catalog",
      "SELECT current_setting('statement_timeout') AS timeout",
      "SELECT set_config('statement_timeout', $1, true)",
      "native bookkeeping and DDL fixture",
      "SELECT set_config('statement_timeout', $1, true)",
    ]);
    expect(queries[5]?.values).toEqual(["120000ms"]);
    expect(queries[7]?.values).toEqual(["60s"]);
    const failed = new Error("native migration failed");
    queries.length = 0;
    await expect(
      withBlockingGinTimeout(client, 1, async () => {
        throw failed;
      }),
    ).rejects.toBe(failed);
    expect(queries).toHaveLength(2); // No reset in an aborted transaction; outer rollback owns restoration.
  });
  expect(() => assertMigrationConnection(owned!)).toThrow("owned");
  await expect(withBlockingGinTimeout(fakeSession(), 1, async () => undefined)).rejects.toThrow("owned");
  expect(state.connection.ended).toBe(1);
  expect(state.poolEnds).toBe(1);
});

test("a server other than PostgreSQL 18 is refused and its session closed", async () => {
  const state = install();
  state.connection = new FakeConnection(() => ({ rows: [{ server_version_num: "170004" }], rowCount: 1 }));
  const operation = vi.fn(async () => undefined);
  await expect(withMigrationConnection("postgres://localhost/db", operation)).rejects.toThrow("PostgreSQL 18");
  expect(operation).not.toHaveBeenCalled();
  expect(state.connection.ended).toBe(1);
});

test("connection cleanup preserves original failures and reports cleanup errors after success", async () => {
  const state = install();
  const cleanup = new Error("end fixture failed");
  state.connection = new FakeConnection(() => version);
  state.connection.endFailure = cleanup;
  const original = new Error("migration fixture failed");
  await expect(
    withMigrationConnection("postgres://localhost/db", async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  await expect(withMigrationConnection("postgres://localhost/db", async () => "complete")).rejects.toBe(cleanup);
  expect(state.poolEnds).toBe(2);
});
