import { expect, test } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineSchema } from "kello/server";
import { emptySnapshot, inspectReleaseSchema, planCustomMigration, planMigration, writeMigration } from "kello-cli";

test("release schema ranges bind ordered artifacts and tolerate unchanged schemas in data migrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-compatibility-"));
  try {
    const baseline = await emptySnapshot("app");
    const firstSchema = defineSchema((f) => ({ tasks: { title: f.text() } }), { namespace: "app" });
    const first = await planMigration(baseline, firstSchema);
    const firstArtifact = await writeMigration(root, "migrations", "initial", first);
    const expandedSchema = defineSchema((f) => ({ tasks: { title: f.text(), note: f.text() } }), { namespace: "app" });
    const expanded = await planMigration(first.snapshot, expandedSchema, [], first.hash);
    await writeMigration(root, "migrations", "expand", expanded);
    const data = await planCustomMigration(
      expanded.snapshot,
      expandedSchema,
      "UPDATE app.tasks SET note = 'ready';",
      "transactional",
      expanded.hash,
    );
    await writeMigration(root, "migrations", "data", data);
    const options = {
      migrations: "migrations",
      namespace: "app",
      migrationHashes: [first.hash, expanded.hash, data.hash],
      schema: { minimum: first.after, maximum: expanded.after, target: expanded.after },
    };
    const proof = await inspectReleaseSchema(root, options);
    expect(proof.schemas).toEqual([first.after, expanded.after]);
    expect(proof.migrationHashes).toEqual(options.migrationHashes);
    expect(proof.head).toBe(expanded.after);
    await expect(
      inspectReleaseSchema(root, { ...options, migrationHashes: [first.hash, expanded.hash] }),
    ).rejects.toThrow("history");
    await expect(inspectReleaseSchema(root, { ...options, namespace: "other" })).rejects.toThrow("namespace");
    await expect(
      inspectReleaseSchema(root, { ...options, schema: { ...options.schema, minimum: "0".repeat(64) } }),
    ).rejects.toThrow("bounds");
    await expect(
      inspectReleaseSchema(root, {
        ...options,
        schema: { ...options.schema, minimum: expanded.after, maximum: first.after },
      }),
    ).rejects.toThrow("bounds");
    await expect(
      inspectReleaseSchema(root, { ...options, schema: { ...options.schema, maximum: first.after } }),
    ).rejects.toThrow("target");
    await expect(
      inspectReleaseSchema(root, { ...options, schema: { ...options.schema, target: first.after } }),
    ).rejects.toThrow("head");
    await writeFile(join(firstArtifact.directory, "migration.sql"), "SELECT 1;\n");
    await expect(inspectReleaseSchema(root, options)).rejects.toThrow("artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty history and migration anchors distinguish repeated structural epochs", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-compatibility-epochs-"));
  try {
    const baseline = await emptySnapshot("app");
    expect(
      (
        await inspectReleaseSchema(root, {
          migrations: "migrations",
          namespace: "app",
          migrationHashes: [],
          schema: { minimum: baseline.id, maximum: baseline.id, target: baseline.id },
        })
      ).schemas,
    ).toEqual([baseline.id]);
    const original = defineSchema((f) => ({ tasks: { title: f.text() } }), { namespace: "app" });
    const first = await planMigration(baseline, original);
    await writeMigration(root, "migrations", "initial", first);
    const expanded = await planMigration(
      first.snapshot,
      defineSchema((f) => ({ tasks: { title: f.text(), note: f.text() } }), { namespace: "app" }),
      [],
      first.hash,
    );
    await writeMigration(root, "migrations", "expand", expanded);
    const contracted = await planMigration(expanded.snapshot, original, [], expanded.hash);
    expect(contracted.after).toBe(first.after);
    await writeMigration(root, "migrations", "contract", contracted);
    const anchored = {
      migrations: "migrations",
      namespace: "app",
      migrationHashes: [first.hash, expanded.hash, contracted.hash],
      schema: {
        minimum: first.after,
        maximum: first.after,
        target: contracted.after,
        minimumMigration: contracted.hash,
        maximumMigration: contracted.hash,
      },
    };
    const proof = await inspectReleaseSchema(root, anchored);
    expect(proof.schemas).toEqual([contracted.after]);
    expect([proof.minimumOrdinal, proof.maximumOrdinal]).toEqual([3, 3]);
    await expect(
      inspectReleaseSchema(root, { ...anchored, schema: { ...anchored.schema, maximumMigration: first.hash } }),
    ).rejects.toThrow("reversed");
    await expect(
      inspectReleaseSchema(root, { ...anchored, schema: { ...anchored.schema, minimumMigration: "0".repeat(64) } }),
    ).rejects.toThrow("anchors");
    await expect(
      inspectReleaseSchema(root, { ...anchored, schema: { ...anchored.schema, minimumMigration: expanded.hash } }),
    ).rejects.toThrow("anchors");
    await expect(
      inspectReleaseSchema(root, {
        migrations: "migrations",
        namespace: "app",
        migrationHashes: [first.hash, expanded.hash, contracted.hash],
        schema: { minimum: first.after, maximum: first.after, target: contracted.after },
      }),
    ).rejects.toThrow("ambiguous");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
