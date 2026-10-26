import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, expect } from "bun:test";
import pg from "pg";
import * as v from "valibot";
import { defineRelations, sql } from "drizzle-orm";
import { bootstrapDatabase, withProcedureUpgrade, ProcedureUpgradeError } from "kello-cli";
import {
  createRpcRuntime,
  defineRpcAuth,
  defineSchema,
  createProjectProcedures,
  createDatabaseMiddleware,
  defineJobMigration,
  encodeRpcJobCall,
} from "kello/server";
import type { JsonValue } from "kello/server";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "durable upgrades preserve envelopes, validate mappings and fence old claims and incompatible rollback",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_upgrade_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const meta = `"${metadataNamespace}"`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      const before = (
        await admin.query(`SELECT version,hash FROM ${meta}.framework_migrations WHERE version<23 ORDER BY version`)
      ).rows;
      await admin.query(`DROP TABLE ${meta}.rate_limit_buckets, ${meta}.rate_limit_policies`);
      await admin.query(`DROP TABLE ${meta}.search_cursor_keys`);
      await admin.query(`DROP TABLE ${meta}.deployment_secrets`);
      await admin.query(`DROP TABLE ${meta}.procedure_releases`);
      await admin.query(`DROP FUNCTION ${meta}.fence_migrated_job_claim() CASCADE`);
      await admin.query(`ALTER TABLE ${meta}.jobs DROP COLUMN claim_version, DROP COLUMN lease_version`);
      await admin.query(`ALTER TABLE ${meta}.storage_intents DROP COLUMN owner_scope`);
      await admin.query(`DROP TABLE ${meta}.component_namespaces, ${meta}.runtime_scopes`);
      await admin.query(`DELETE FROM ${meta}.framework_migrations WHERE version>=23`);
      const oldVersion = "a".repeat(64);
      const version = "b".repeat(64);
      const original = { version: oldVersion, name: "jobs:increment", kind: "mutation", args: { amount: 2 } };
      async function insert(call: JsonValue): Promise<string> {
        const id = crypto.randomUUID();
        await admin.query(
          `INSERT INTO ${meta}.jobs(id,deployment,deduplication_key,fingerprint,call,identity,due_at,max_attempts,retry_delay_seconds)
        VALUES($1::uuid,'test',$1::text,$2,$3::jsonb,'null',clock_timestamp(),3,0)`,
          [id, "c".repeat(64), JSON.stringify(call)],
        );
        return id;
      }
      const id = await insert(original);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (await admin.query(`SELECT version,hash FROM ${meta}.framework_migrations WHERE version<23 ORDER BY version`))
          .rows,
      ).toEqual(before);
      expect((await admin.query(`SELECT call,attempts FROM ${meta}.jobs WHERE id=$1`, [id])).rows).toEqual([
        { call: original, attempts: 0 },
      ]);
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      await admin.query(`CREATE TABLE ${meta}.counter(value integer NOT NULL)`);
      await admin.query(`INSERT INTO ${meta}.counter VALUES(0)`);
      await admin.query(`GRANT SELECT,UPDATE ON ${meta}.counter TO "${runtimeRole}"`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      const runtimeConnection = new pg.Client({ connectionString: address.href });
      await runtimeConnection.connect();
      try {
        const schema = defineSchema(() => ({}));
        const relations = defineRelations(schema.tables);
        const { procedure } = createProjectProcedures(schema);
        const increment = procedure
          .input(v.strictObject({ delta: v.number() }))
          .use(createDatabaseMiddleware(relations, "write", schema))
          .handler(async ({ context, input }) => {
            const result = await context.db.execute<{ value: number }>(
              sql`UPDATE ${sql.identifier(metadataNamespace)}.counter SET value=value+${input.delta} RETURNING value`,
            );
            return result.rows[0]!.value;
          });
        const migration = defineJobMigration({
          from: { protocol: "loom-legacy-1", version: oldVersion, name: "jobs:increment", kind: "mutation" },
          input: v.strictObject({ amount: v.number() }),
          to: increment,
          transform: (input) => ({ delta: input.amount }),
        });
        const procedures = [{ path: ["jobs", "increment"], visibility: "internal" as const, procedure: increment }];
        const upgrade = {
          metadataNamespace,
          deployment: "test",
          version,
          protocol: "loom-orpc-2" as const,
          procedures,
          migrations: [migration],
        };
        await assert.rejects(
          withProcedureUpgrade(admin, { ...upgrade, migrations: [] }, async () => {}),
          (error) => error instanceof ProcedureUpgradeError && error.inventory[0]?.reason === "missing-mapping",
        );
        expect(
          (await admin.query(`SELECT claim_version FROM ${meta}.jobs WHERE id=$1`, [id])).rows[0].claim_version,
        ).toBeNull();
        await assert.rejects(
          withProcedureUpgrade(admin, upgrade, async () => {
            throw new Error("activation failed");
          }),
          /activation failed/,
        );
        expect((await admin.query(`SELECT count(*) FROM ${meta}.procedure_releases`)).rows[0].count).toBe("0");
        await withProcedureUpgrade(admin, { ...upgrade, dryRun: true }, async () => {});
        expect(
          (await admin.query(`SELECT claim_version FROM ${meta}.jobs WHERE id=$1`, [id])).rows[0].claim_version,
        ).toBeNull();
        await withProcedureUpgrade(admin, upgrade, async () => {});
        await withProcedureUpgrade(admin, upgrade, async () => {});
        expect(
          (await admin.query(`SELECT call,claim_version,fencing_token::text FROM ${meta}.jobs WHERE id=$1`, [id])).rows,
        ).toEqual([{ call: original, claim_version: version, fencing_token: "1" }]);
        await assert.rejects(
          runtimeConnection.query(`UPDATE ${meta}.jobs SET claim_version=$1 WHERE id=$2`, [oldVersion, id]),
          /permission denied/,
        );
        const oldClaim = () =>
          runtimeConnection.query(
            `UPDATE ${meta}.jobs SET state='running',attempts=attempts+1,lease_owner='old',lease_expires_at=clock_timestamp()+interval '10 seconds',fencing_token=fencing_token+1 WHERE id=$1`,
            [id],
          );
        await assert.rejects(oldClaim(), /different runtime version/);
        const runtime = await createRpcRuntime({
          schema,
          relations,
          connectionString: address.href,
          metadataNamespace,
          deployment: "test",
          version,
          procedures,
          jobMigrations: [migration],
          auth: defineRpcAuth({ authorize: () => {} }),
          assertActive: async () => {},
        });
        try {
          expect(await runtime.worker.run()).toMatchObject({ completed: 1 });
          expect((await admin.query(`SELECT value FROM ${meta}.counter`)).rows).toEqual([{ value: 2 }]);
          expect((await admin.query(`SELECT call FROM ${meta}.jobs WHERE id=$1`, [id])).rows[0].call).toEqual(original);
          // Simulate a lost completion acknowledgement after the write receipt committed.
          await admin.query(
            `UPDATE ${meta}.jobs SET state='pending',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,
            [id],
          );
          await assert.rejects(oldClaim(), /different runtime version/);
          await assert.rejects(
            withProcedureUpgrade(admin, { ...upgrade, version: "c".repeat(64) }, async () => {}),
            (error) => error instanceof ProcedureUpgradeError && error.inventory[0]?.reason === "replay-receipt",
          );
          expect(await runtime.worker.run()).toMatchObject({ completed: 1 });
          expect((await admin.query(`SELECT value FROM ${meta}.counter`)).rows).toEqual([{ value: 2 }]);
        } finally {
          await runtime.stop();
        }
        const invalid = await insert({ ...original, args: { amount: "wrong" } });
        await assert.rejects(
          withProcedureUpgrade(admin, upgrade, async () => {}),
          ProcedureUpgradeError,
        );
        await admin.query(`DELETE FROM ${meta}.jobs WHERE id=$1`, [invalid]);
        const receiptJob = await insert(original);
        await admin.query(
          `INSERT INTO ${meta}.mutation_results(scope_hash,key_hash,fingerprint,result,expires_at) VALUES($1,$2,$1,'null',clock_timestamp()+interval '1 day')`,
          ["d".repeat(64), createHash("sha256").update(receiptJob).digest("hex")],
        );
        await assert.rejects(
          withProcedureUpgrade(admin, upgrade, async () => {}),
          (error) => error instanceof ProcedureUpgradeError && error.inventory[0]?.reason === "replay-receipt",
        );
        await admin.query(`DELETE FROM ${meta}.jobs WHERE id=$1`, [receiptJob]);
        const current = encodeRpcJobCall(version, ["jobs", "increment"], { delta: 1 });
        await insert(JSON.parse(JSON.stringify(current)));
        await assert.rejects(
          withProcedureUpgrade(
            admin,
            { ...upgrade, version: "e".repeat(64), protocol: "loom-legacy-1", migrations: [] },
            async () => {},
          ),
          (error) => error instanceof ProcedureUpgradeError && error.inventory[0]?.reason === "rollback-incompatible",
        );
      } finally {
        await runtimeConnection.end();
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${meta} CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
);
