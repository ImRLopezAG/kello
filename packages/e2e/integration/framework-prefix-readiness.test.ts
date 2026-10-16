import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateRelease } from "kello/tooling";
import type { NeonReleaseJournal } from "kello/tooling";
import { applyMigrations } from "../../../apps/kello/src/tooling/migrations/runner";
import { migrationStatus } from "../../../apps/kello/src/tooling/migrations/status";
import { frameworkMigrations } from "../../../apps/kello/src/tooling/migrations/bootstrap";
import { quoteIdentifier } from "../../../apps/kello/src/tooling/migrations/connection";
import { ormHistoryTable } from "../../../apps/kello/src/tooling/migrations/state";
import { withNeonReleaseDatabase } from "../../../apps/kello/src/tooling/deploy/neon/release-database";
import { planProjectRelease } from "../../../apps/kello/src/tooling/deploy/neon/plan-release";
import type { readProjectRelease } from "../../../apps/kello/src/tooling/deploy/neon/project";
import { withFrameworkPrefixFixture, makeVersion26, historySnapshot } from "../fixtures/framework-prefix-readiness";
import type { FrameworkPrefixFixture } from "../fixtures/framework-prefix-readiness";

const nativeTest = test.skipIf(!process.env.LOOM_TEST_DATABASE_URL);
const runnerOptions = (fixture: FrameworkPrefixFixture) => ({
  connectionString: fixture.url,
  root: fixture.root,
  namespace: fixture.namespace,
  metadataNamespace: fixture.metadataNamespace,
  runtimeRole: fixture.runtimeRole,
  migrations: fixture.migrations,
});

async function completeProviderJournal(journal: NeonReleaseJournal) {
  const functions = [
    { role: "service", functionId: "service", deploymentId: 1, slug: "service" },
    { role: "worker", functionId: "worker", deploymentId: 1, slug: "worker" },
  ] as const;
  await journal.complete({
    stage: "bootstrap",
    artifactHash: "d".repeat(64),
    functions: [functions[0], functions[1]],
  });
  await journal.complete({ stage: "triggers", triggers: [], bindings: {} });
  await journal.complete({
    stage: "functions",
    artifactHash: "e".repeat(64),
    functions: [functions[0], functions[1]],
  });
  await journal.complete({ stage: "health" });
  await journal.complete({ stage: "activated" });
  await journal.complete({ stage: "complete", enabledTriggerIds: [] });
}

async function completeRelease(fixture: FrameworkPrefixFixture) {
  await withNeonReleaseDatabase(
    fixture.root,
    fixture.options,
    async ({ activation, journal }) => {
      await activation.activate();
      await completeProviderJournal(journal);
    },
    fixture.provider,
  );
  await fixture.admin.query(`INSERT INTO ${quoteIdentifier(fixture.namespace)}.tasks(title) VALUES ('preserved')`);
  await fixture.admin.query(
    `INSERT INTO ${quoteIdentifier(fixture.metadataNamespace)}.jobs(id,deployment,deduplication_key,fingerprint,call,identity,due_at,max_attempts,retry_delay_seconds) VALUES(gen_random_uuid(),'preview','keep',repeat('a',64),'{}','{}',now(),1,0)`,
  );
}

async function writePlanningDeclaration(fixture: FrameworkPrefixFixture, retainedReleaseKey?: string) {
  const { inputHash: _inputHash, activationToken: _activationToken, ...declaration } = fixture.options;
  const planningDeclaration: Awaited<ReturnType<typeof readProjectRelease>>["declaration"] = {
    ...declaration,
    componentScopes: [],
    format: 1,
    slugs: { service: "service", worker: "worker" },
    activationTokenEnv: "DEPLOY_TOKEN",
    variables: { LOOM_DATABASE_URL: "RUNTIME_URL" },
  };
  if (retainedReleaseKey) {
    planningDeclaration.releaseKey = "f".repeat(64);
    planningDeclaration.retainedReleaseKey = retainedReleaseKey;
    planningDeclaration.quarantine = "preserve";
  }
  await writeFile(join(fixture.root, "release.json"), JSON.stringify(planningDeclaration));
}

async function observePlanWithoutWrites(fixture: FrameworkPrefixFixture) {
  const path = join(fixture.root, ".loom/releases", fixture.options.releaseKey, "release.json");
  const receipt = await readFile(path, "utf8");
  const before = await historySnapshot(fixture);
  const plan = await planProjectRelease(fixture.root, "release.json", fixture.planner);
  assert.deepEqual(await historySnapshot(fixture), before);
  assert.equal(await readFile(path, "utf8"), receipt);
  assert.equal(fixture.providerMutations(), 0);
  return plan;
}

nativeTest(
  "native runner upgrades an exact v26 prefix with no application work and with an additive artifact",
  async () => {
    await withFrameworkPrefixFixture(async (fixture) => {
      assert.equal(fixture.artifact.plan.format, 2);
      const options = runnerOptions(fixture);
      await applyMigrations(options);
      await fixture.admin.query(`INSERT INTO ${quoteIdentifier(fixture.namespace)}.tasks(title) VALUES ('preserved')`);
      const originalArtifact = await readFile(
        join(fixture.root, fixture.migrations, fixture.artifact.name, "plan.json"),
        "utf8",
      );
      const original = await historySnapshot(fixture);
      assert.equal(original.framework.length, frameworkMigrations(fixture.metadataNamespace).length);
      await makeVersion26(fixture);
      const receipt = await applyMigrations(options);
      assert.deepEqual(receipt.applied, []);
      assert.deepEqual(await historySnapshot(fixture), original);
      assert.equal(
        await readFile(join(fixture.root, fixture.migrations, fixture.artifact.name, "plan.json"), "utf8"),
        originalArtifact,
      );
      const { runtimeRole: _runtimeRole, ...statusOptions } = options;
      const current = await migrationStatus(statusOptions);
      assert.equal(current.consistent, true);
      assert.equal(current.framework.state, "current");
      await writeFile(
        fixture.schemaFile,
        (await readFile(fixture.schemaFile, "utf8")).replace(
          "title: s.text().notNull()",
          "title: s.text().notNull(), note: s.text()",
        ),
      );
      const addition = await generateRelease(fixture.root, "add_note");
      await makeVersion26(fixture);
      const changed = await applyMigrations(options);
      assert.deepEqual(changed.applied, [addition.plan.hash]);
      const after = await historySnapshot(fixture);
      assert.deepEqual(after.framework, original.framework);
      assert.deepEqual(after.application.slice(0, 1), original.application);
      assert.deepEqual(after.orm.slice(0, 1), original.orm);
      assert.equal(after.data[0]?.title, "preserved");
      assert.equal(after.data[0]?.note, null);
    });
  },
  120_000,
);

nativeTest(
  "native completed exact receipt resume upgrades framework without replaying quarantine or provider mutations",
  async () => {
    await withFrameworkPrefixFixture(async (fixture) => {
      await completeRelease(fixture);
      const path = join(fixture.root, ".loom/releases", fixture.options.releaseKey, "release.json");
      const receipt = await readFile(path, "utf8");
      const before = await historySnapshot(fixture);
      await makeVersion26(fixture);
      let callbacks = 0;
      await withNeonReleaseDatabase(
        fixture.root,
        fixture.options,
        async ({ activation, client }) => {
          callbacks++;
          await activation.assertActive();
          assert.equal(
            (
              await client.query(
                `SELECT max(version) AS version FROM ${quoteIdentifier(fixture.metadataNamespace)}.framework_migrations`,
              )
            ).rows[0]?.version,
            frameworkMigrations(fixture.metadataNamespace).length,
          );
          assert.equal(
            (
              await client.query("SELECT to_regclass($1)::text AS relation", [
                `${quoteIdentifier(fixture.metadataNamespace)}.search_cursor_keys`,
              ])
            ).rows[0]?.relation != null,
            true,
          );
        },
        fixture.provider,
      );
      assert.equal(callbacks, 1);
      assert.deepEqual(await historySnapshot(fixture), before);
      assert.equal(await readFile(path, "utf8"), receipt);
      assert.equal(fixture.providerMutations(), 0);
    });
  },
  120_000,
);

nativeTest(
  "native readonly release plan reports authenticated metadata upgrade after completed receipt without writes",
  async () => {
    await withFrameworkPrefixFixture(async (fixture) => {
      await completeRelease(fixture);
      const { inputHash: _inputHash, activationToken: _activationToken, ...declaration } = fixture.options;
      await writeFile(
        join(fixture.root, "release.json"),
        JSON.stringify({
          ...declaration,
          format: 1,
          slugs: { service: "service", worker: "worker" },
          activationTokenEnv: "DEPLOY_TOKEN",
          variables: { LOOM_DATABASE_URL: "RUNTIME_URL" },
        }),
      );
      await makeVersion26(fixture);
      const path = join(fixture.root, ".loom/releases", fixture.options.releaseKey, "release.json");
      const receipt = await readFile(path, "utf8");
      const before = await historySnapshot(fixture);
      const plan = await planProjectRelease(fixture.root, "release.json", fixture.planner);
      assert.equal(plan.metadata, "bootstrap-existing");
      assert.deepEqual(plan.migrations.framework, {
        state: "upgrade-required",
        appliedVersion: 26,
        pending: frameworkMigrations(fixture.metadataNamespace)
          .slice(26)
          .map(({ version, hash }) => ({ version, hash })),
      });
      assert(!plan.blockers.some((blocker) => blocker.code === "DATABASE_INCONSISTENT"));
      assert.deepEqual(await historySnapshot(fixture), before);
      assert.equal(await readFile(path, "utf8"), receipt);
      assert.equal(fixture.providerMutations(), 0);
    });
  },
  120_000,
);

nativeTest(
  "native v26 readonly plan retains superseded ingress and active previous worker observations",
  async () => {
    await withFrameworkPrefixFixture(async (fixture) => {
      await completeRelease(fixture);
      await writePlanningDeclaration(fixture);
      const meta = quoteIdentifier(fixture.metadataNamespace);
      await fixture.admin.query(
        `UPDATE ${meta}.release_ingress SET state='retired' WHERE project_id='project' AND branch_id='br-preview' AND deployment=$1 AND release_key=$2`,
        [fixture.options.deployment, fixture.options.releaseKey],
      );
      await fixture.admin.query(
        `INSERT INTO ${meta}.deployment_activations(deployment,version,project_id,branch_id,endpoint_host,database_name,token_hash,state)
         SELECT deployment,repeat('f',64),project_id,branch_id,endpoint_host,database_name,token_hash,state
         FROM ${meta}.deployment_activations WHERE deployment=$1 AND version=$2`,
        [fixture.options.deployment, fixture.options.version],
      );
      await fixture.admin.query(
        `INSERT INTO ${meta}.function_ownership(project_id,branch_id,slug,deployment,version,role) VALUES('project','br-preview','oldworker',$1,repeat('f',64),'worker')`,
        [fixture.options.deployment],
      );
      const current = await observePlanWithoutWrites(fixture);
      assert(current.blockers.some((blocker) => blocker.code === "RELEASE_SUPERSEDED"));
      assert.deepEqual(current.ingressHandoff.retainedWorkers, ["oldworker"]);
      await makeVersion26(fixture);
      const prefix = await observePlanWithoutWrites(fixture);
      assert.equal(prefix.metadata, "bootstrap-existing");
      assert(prefix.blockers.some((blocker) => blocker.code === "RELEASE_SUPERSEDED"));
      assert.deepEqual(prefix.ingressHandoff.retainedWorkers, ["oldworker"]);
      assert(!prefix.blockers.some((blocker) => blocker.code === "DATABASE_INCONSISTENT"));
    });
  },
  120_000,
);

nativeTest(
  "native v26 readonly retained plan observes an active grant without inferring inactivity from metadata upgrade",
  async () => {
    await withFrameworkPrefixFixture(async (fixture) => {
      await completeRelease(fixture);
      await writePlanningDeclaration(fixture, fixture.options.releaseKey);
      const current = await observePlanWithoutWrites(fixture);
      assert(!current.blockers.some((blocker) => blocker.code === "RETAINED_RUNTIME_INACTIVE"));
      await makeVersion26(fixture);
      const prefix = await observePlanWithoutWrites(fixture);
      assert.equal(prefix.metadata, "bootstrap-existing");
      assert(!prefix.blockers.some((blocker) => blocker.code === "RETAINED_RUNTIME_INACTIVE"));
      assert(!prefix.blockers.some((blocker) => blocker.code === "DATABASE_INCONSISTENT"));
      await assert.rejects(readFile(join(fixture.root, ".loom/releases", "f".repeat(64), "release.json")), {
        code: "ENOENT",
      });
    });
  },
  120_000,
);

nativeTest(
  "native v26 readonly retained plan blocks an actually missing active grant without writes",
  async () => {
    await withFrameworkPrefixFixture(async (fixture) => {
      await completeRelease(fixture);
      await writePlanningDeclaration(fixture, fixture.options.releaseKey);
      await fixture.admin.query(
        `DELETE FROM ${quoteIdentifier(fixture.metadataNamespace)}.deployment_activations WHERE deployment=$1 AND version=$2`,
        [fixture.options.deployment, fixture.options.version],
      );
      const current = await observePlanWithoutWrites(fixture);
      assert(current.blockers.some((blocker) => blocker.code === "RETAINED_RUNTIME_INACTIVE"));
      await makeVersion26(fixture);
      const prefix = await observePlanWithoutWrites(fixture);
      assert.equal(prefix.metadata, "bootstrap-existing");
      assert(prefix.blockers.some((blocker) => blocker.code === "RETAINED_RUNTIME_INACTIVE"));
      await assert.rejects(readFile(join(fixture.root, ".loom/releases", "f".repeat(64), "release.json")), {
        code: "ENOENT",
      });
    });
  },
  120_000,
);

nativeTest(
  "native v24 readonly retained plan explicitly defers metadata observations without inventing inactivity",
  async () => {
    await withFrameworkPrefixFixture(async (fixture) => {
      await completeRelease(fixture);
      await writePlanningDeclaration(fixture, fixture.options.releaseKey);
      await makeVersion26(fixture);
      const meta = quoteIdentifier(fixture.metadataNamespace);
      await fixture.admin.query("BEGIN");
      try {
        await fixture.admin.query(`ALTER TABLE ${meta}.storage_intents DROP COLUMN owner_scope`);
        await fixture.admin.query(`DROP TABLE ${meta}.runtime_scopes`);
        await fixture.admin.query(`DROP TABLE ${meta}.component_namespaces`);
        await fixture.admin.query(`DELETE FROM ${meta}.framework_migrations WHERE version>=25`);
        await fixture.admin.query("COMMIT");
      } catch (cause) {
        await fixture.admin.query("ROLLBACK");
        throw cause;
      }
      const prefix = await observePlanWithoutWrites(fixture);
      assert.equal(prefix.metadata, "bootstrap-existing");
      assert.equal(prefix.migrations.framework.state, "upgrade-required");
      if (prefix.migrations.framework.state !== "upgrade-required") throw new Error("Expected older framework prefix");
      assert.equal(prefix.migrations.framework.appliedVersion, 24);
      assert(prefix.blockers.some((blocker) => blocker.code === "FRAMEWORK_UPGRADE_REQUIRED"));
      assert(!prefix.blockers.some((blocker) => blocker.code === "RETAINED_RUNTIME_INACTIVE"));
      assert(!prefix.blockers.some((blocker) => blocker.code === "DATABASE_INCONSISTENT"));
      await assert.rejects(readFile(join(fixture.root, ".loom/releases", "f".repeat(64), "release.json")), {
        code: "ENOENT",
      });
    });
  },
  120_000,
);

for (const corruption of ["hash", "gap", "newer", "unversioned", "application", "orm", "catalog"] as const) {
  nativeTest(
    `native prefix refuses ${corruption} corruption before application DDL or completed-release callback`,
    async () => {
      await withFrameworkPrefixFixture(async (fixture) => {
        await completeRelease(fixture);
        await makeVersion26(fixture);
        const meta = quoteIdentifier(fixture.metadataNamespace);
        if (corruption === "hash")
          await fixture.admin.query(`UPDATE ${meta}.framework_migrations SET hash=repeat('f',64) WHERE version=26`);
        if (corruption === "gap")
          await fixture.admin.query(`DELETE FROM ${meta}.framework_migrations WHERE version=25`);
        if (corruption === "newer")
          await fixture.admin.query(`INSERT INTO ${meta}.framework_migrations(version,hash) VALUES(30,repeat('f',64))`);
        if (corruption === "unversioned")
          await fixture.admin.query(`ALTER TABLE ${meta}.framework_migrations RENAME TO unauthenticated_framework`);
        if (corruption === "application")
          await fixture.admin.query(`UPDATE ${meta}.migration_history SET hash=repeat('f',64)`);
        if (corruption === "orm")
          await fixture.admin.query(
            `UPDATE ${meta}.${quoteIdentifier(ormHistoryTable(fixture.namespace))} SET hash=repeat('f',64)`,
          );
        if (corruption === "catalog")
          await fixture.admin.query(
            `ALTER TABLE ${quoteIdentifier(fixture.namespace)}.tasks ADD COLUMN unrelated text`,
          );
        // Restore the original name only for observation; the tested operations must see the missing ledger.
        const observe = async () => {
          if (corruption !== "unversioned") return historySnapshot(fixture);
          await fixture.admin.query(`ALTER TABLE ${meta}.unauthenticated_framework RENAME TO framework_migrations`);
          try {
            return await historySnapshot(fixture);
          } finally {
            await fixture.admin.query(`ALTER TABLE ${meta}.framework_migrations RENAME TO unauthenticated_framework`);
          }
        };
        const before = await observe();
        const path = join(fixture.root, ".loom/releases", fixture.options.releaseKey, "release.json");
        const receipt = await readFile(path, "utf8");
        let callbacks = 0;
        await assert.rejects(
          withNeonReleaseDatabase(
            fixture.root,
            fixture.options,
            async () => {
              callbacks++;
            },
            fixture.provider,
          ),
          /inconsistent|framework/i,
        );
        assert.equal(callbacks, 0);
        assert.deepEqual(await observe(), before);
        assert.equal(await readFile(path, "utf8"), receipt);
        await writeFile(
          fixture.schemaFile,
          (await readFile(fixture.schemaFile, "utf8")).replace(
            "title: s.text().notNull()",
            "title: s.text().notNull(), note: s.text()",
          ),
        );
        await generateRelease(fixture.root, "add_note");
        await assert.rejects(applyMigrations(runnerOptions(fixture)), /history|drift|framework/i);
        assert.deepEqual(await observe(), before);
        assert.equal(fixture.providerMutations(), 0);
      });
    },
    120_000,
  );
}
