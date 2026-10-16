import { expect, test, vi } from "vite-plus/test";
import pg from "pg";
import {
  assertMigrationConnection,
  withMigrationConnection,
  withBlockingGinTimeout,
} from "../../../apps/loom/src/tooling/migrations/connection";

test("Neon migration URLs preserve certificate verification before connecting", async () => {
  const clients: pg.Client[] = [];
  const stopped = new Error("Connection intercepted before network access");
  const connect = vi.spyOn(pg.Client.prototype, "connect").mockImplementation(async function (this: pg.Client) {
    clients.push(this);
    throw stopped;
  });
  const operation = vi.fn(async () => undefined);
  try {
    for (const query of ["", "?sslmode=no-verify", "?sslmode=require&uselibpqcompat=true"]) {
      await expect(
        withMigrationConnection(`postgres://migrator:secret@ep-fixture.eu.neon.tech/db${query}`, operation),
      ).rejects.toBe(stopped);
      expect(clients.at(-1)?.ssl).toEqual({});
    }
    await expect(
      withMigrationConnection("postgres://migrator:secret@localhost/db?sslmode=no-verify", operation),
    ).rejects.toBe(stopped);
    expect(clients.at(-1)?.ssl).toEqual({ rejectUnauthorized: false });
    await expect(withMigrationConnection("https://ep-fixture.eu.neon.tech/db", operation)).rejects.toThrow(
      "Expected a PostgreSQL migration URL",
    );
    expect(clients).toHaveLength(4);
    expect(operation).not.toHaveBeenCalled();
  } finally {
    connect.mockRestore();
  }
});

test("owned migration defaults remain 5s/60s and a local timeout surrounds the complete operation", async () => {
  const queries: { sql: string; values: readonly string[] | undefined }[] = [];
  const connect = vi.spyOn(pg.Client.prototype, "connect").mockResolvedValue(undefined);
  const end = vi.spyOn(pg.Client.prototype, "end").mockResolvedValue(undefined);
  // SAFETY: This mock covers every query used here: SQL strings, optional string bindings, and awaited rows.
  const query = vi.spyOn(pg.Client.prototype, "query").mockImplementation((async (
    sql: string,
    values?: readonly string[],
  ) => {
    queries.push({ sql, values });
    return {
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: sql === "SHOW server_version_num" ? [{ server_version_num: "180006" }] : [{ timeout: "60s" }],
    };
  }) as pg.Client["query"]);
  let owned: pg.Client | undefined;
  try {
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
    await expect(withBlockingGinTimeout(new pg.Client(), 1, async () => undefined)).rejects.toThrow("owned");
  } finally {
    connect.mockRestore();
    end.mockRestore();
    query.mockRestore();
  }
});

test("connection cleanup preserves original failures and reports cleanup errors after success", async () => {
  const connect = vi.spyOn(pg.Client.prototype, "connect").mockResolvedValue(undefined);
  const cleanup = new Error("end fixture failed");
  const end = vi.spyOn(pg.Client.prototype, "end").mockRejectedValue(cleanup);
  // SAFETY: This mock covers setup SQL with an awaited complete pg result; this callback performs no other queries.
  const query = vi.spyOn(pg.Client.prototype, "query").mockImplementation((async () => ({
    command: "SELECT",
    rowCount: 1,
    oid: 0,
    fields: [],
    rows: [{ server_version_num: "180006" }],
  })) as pg.Client["query"]);
  const original = new Error("migration fixture failed");
  try {
    await expect(
      withMigrationConnection("postgres://localhost/db", async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    await expect(withMigrationConnection("postgres://localhost/db", async () => "complete")).rejects.toBe(cleanup);
  } finally {
    connect.mockRestore();
    end.mockRestore();
    query.mockRestore();
  }
});
