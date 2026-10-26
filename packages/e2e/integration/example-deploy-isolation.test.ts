import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { applyMigrations, loadProject } from "kello-cli";
import pg from "pg";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "example migrations and runtime roles remain isolated in one database",
  async () => {
    assert(connectionString);
    const address = new URL(connectionString);
    assert(["127.0.0.1", "localhost", "[::1]"].includes(address.hostname), "Local test database required");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const database = `loom_examples_${suffix}`;
    const admin = new pg.Client({ connectionString });
    const roles: string[] = [];
    let db: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${database}"`);
      address.pathname = `/${database}`;
      db = new pg.Client({ connectionString: address.href });
      await db.connect();
      const projects = await Promise.all(
        ["integrations", "next", "start"].map(async (example) => {
          const root = fileURLToPath(new URL(`../../examples/${example}/`, import.meta.url));
          return { root, example, project: await loadProject(root) };
        }),
      );
      for (const key of ["namespace", "metadataNamespace"] as const) {
        expect(new Set(projects.map(({ project }) => project.config.database[key])).size).toBe(3);
      }
      expect(new Set(projects.map(({ project }) => project.version)).size).toBe(3);
      for (const { root, example, project } of projects) {
        const { namespace, metadataNamespace, migrations } = project.config.database;
        const role = `ex_${roles.length}_${suffix}`;
        roles.push(role);
        const receipt = await applyMigrations({
          connectionString: address.href,
          root,
          migrations,
          namespace,
          metadataNamespace,
          runtimeRole: role,
        });
        expect(receipt.applied).toHaveLength(1);
        await db.query(
          `INSERT INTO "${namespace}".notes (text, owner, issuer) VALUES ($1, 'same-owner', 'same-issuer')`,
          [example],
        );
      }
      for (const [index, { example, project }] of projects.entries()) {
        const { namespace } = project.config.database;
        await db.query(`SET ROLE "${roles[index]}"`);
        try {
          expect((await db.query(`SELECT text FROM "${namespace}".notes`)).rows).toEqual([{ text: example }]);
          for (const { project: other } of projects) {
            if (other === project) continue;
            await assert.rejects(db.query(`SELECT text FROM "${other.config.database.namespace}".notes`), {
              code: "42501",
            });
          }
        } finally {
          await db.query("RESET ROLE");
        }
      }
    } finally {
      await db?.end();
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        for (const role of roles) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      } finally {
        await admin.end();
      }
    }
  },
  30_000,
);
