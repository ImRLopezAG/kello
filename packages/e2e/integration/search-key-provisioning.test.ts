import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import pg from "pg";
import { bootstrapDatabase } from "kello/tooling";
import { provisionSearchCursorKey } from "../../../apps/kello/src/tooling/deploy/neon/search-key";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "cursor secrets survive releases and isolate branch ownership",
  async () => {
    assert(connectionString);
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_keys_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const clients = [new pg.Client({ connectionString }), new pg.Client({ connectionString })];
    await Promise.all(clients.map((client) => client.connect()));
    const owner = clients[0]!;
    let runtime: pg.Client | undefined;
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      const options = { metadataNamespace, projectId: "project", branchId: "br-one" };
      const [first, concurrent] = await Promise.all(clients.map((client) => provisionSearchCursorKey(client, options)));
      assert(first);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(concurrent).toBe(first);
      expect(await provisionSearchCursorKey(owner, options)).toBe(first);
      const otherBranch = await provisionSearchCursorKey(owner, { ...options, branchId: "br-two" });
      expect(otherBranch).not.toBe(first);
      expect(await provisionSearchCursorKey(owner, { ...options, projectId: "another" })).not.toBe(first);
      const password = crypto.randomUUID().replaceAll("-", "");
      await owner.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD '${password}'`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = password;
      runtime = new pg.Client({ connectionString: address.href });
      await runtime.connect();
      await assert.rejects(
        runtime.query(`SELECT * FROM "${metadataNamespace}".search_cursor_keys`),
        /permission denied/,
      );
      await assert.rejects(provisionSearchCursorKey(runtime, options), /metadata owner/);
      await owner.query(
        `UPDATE "${metadataNamespace}".search_cursor_keys SET key=$1 WHERE project_id=$2 AND branch_id=$3`,
        ["09".repeat(32), options.projectId, options.branchId],
      );
      expect(await provisionSearchCursorKey(owner, options)).toBe("09".repeat(32));
    } finally {
      await runtime?.end();
      await owner.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await owner.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await Promise.all(clients.map((client) => client.end()));
    }
  },
  120_000,
);
