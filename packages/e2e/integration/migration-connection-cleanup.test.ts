import { expect, test } from "bun:test";
import * as pg from "../fixtures/postgres";
import {
  acquireMigrationLock,
  withMigrationConnection,
} from "../../../apps/kello-cli/src/tooling/migrations/connection";

const connectionString = process.env.KELLO_TEST_DATABASE_URL;

test("a refused connection rejects without running the operation", async () => {
  let operationCalls = 0;
  // Port 1 on loopback refuses immediately; nothing listens there.
  await expect(
    withMigrationConnection("postgresql://kello@127.0.0.1:1/unused", async () => {
      operationCalls++;
    }),
  ).rejects.toThrow();
  expect(operationCalls).toBe(0);
});

test.skipIf(!connectionString)("a failed migration closes its session and releases its locks", async () => {
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  const key = `kello:cleanup:${crypto.randomUUID()}`;
  const failure = new Error("migration fixture failed");
  let pid: number | undefined;
  try {
    await expect(
      withMigrationConnection(connectionString!, async (client) => {
        pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        await acquireMigrationLock(client, key);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(pid).toBeNumber();
    // The backend exits asynchronously after the socket closes.
    for (let attempt = 0; attempt < 100; attempt++) {
      const live = await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid]);
      if (live.rowCount === 0) break;
      await Bun.sleep(20);
    }
    expect((await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid])).rowCount).toBe(0);
    const lock = await admin.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired", [key]);
    expect(lock.rows[0].acquired).toBe(true);
    await admin.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
  } finally {
    await admin.end();
  }
});
