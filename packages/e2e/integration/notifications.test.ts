import { expect, test } from "bun:test";
import { channel } from "node:diagnostics_channel";
import pg from "pg";
import * as v from "valibot";
import { bootstrapDatabase, installRevisionTracking } from "kello/tooling";
import { listenForRevisions, revisionNotificationChannel } from "kello/server";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;

test.skipIf(!connectionString)(
  "restricted LISTEN observes committed SQL and reconnects without trusting payloads",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_${suffix}`;
    const namespace = `app_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    let listener: ReturnType<typeof listenForRevisions> | undefined;
    const metric = channel("kello.runtime.metric");
    const statuses: string[] = [];
    const record: Parameters<typeof metric.subscribe>[0] = (event) => {
      const result = v.safeParse(
        v.object({ type: v.literal("realtime.listener"), status: v.picklist(["connected", "degraded", "idle"]) }),
        event,
      );
      if (result.success) statuses.push(result.output.status);
    };
    metric.subscribe(record);
    let wakes = 0;
    const waitFor = async (check: () => boolean) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (check()) return;
        await Bun.sleep(10);
      }
      throw new Error("Notification did not arrive");
    };
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      await admin.query(`CREATE SCHEMA "${namespace}"`);
      await admin.query(`CREATE TABLE "${namespace}".tasks (id integer PRIMARY KEY)`);
      await admin.query("BEGIN");
      await installRevisionTracking(admin, namespace, metadataNamespace, ["tasks"]);
      await admin.query("COMMIT");
      // Reconstruct metadata version 21, including removal of later job fences,
      // then prove the notification upgrade preserves its installed trigger and history.
      await admin.query(
        `DROP TABLE "${metadataNamespace}".rate_limit_buckets, "${metadataNamespace}".rate_limit_policies`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".search_cursor_keys`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(`ALTER TABLE "${metadataNamespace}".jobs DROP COLUMN claim_version, DROP COLUMN lease_version`);
      await admin.query(`ALTER TABLE "${metadataNamespace}".storage_intents DROP COLUMN owner_scope`);
      await admin.query(
        `DROP TABLE "${metadataNamespace}".component_namespaces, "${metadataNamespace}".runtime_scopes`,
      );
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 22`);
      await admin.query(`CREATE OR REPLACE FUNCTION "${metadataNamespace}".advance_table_revision() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $kello$
      BEGIN
        UPDATE "${metadataNamespace}".table_revisions SET revision = revision + 1
        WHERE namespace = TG_TABLE_SCHEMA AND table_name = TG_TABLE_NAME;
        IF NOT FOUND THEN RAISE EXCEPTION 'Missing Kello table revision'; END IF;
        RETURN NULL;
      END
      $kello$`);
      const history = (
        await admin.query(`SELECT version,hash FROM "${metadataNamespace}".framework_migrations ORDER BY version`)
      ).rows;
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(`SELECT version,hash FROM "${metadataNamespace}".framework_migrations ORDER BY version`)
        ).rows.slice(0, history.length),
      ).toEqual(history);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      listener = listenForRevisions(
        { connectionString: address.href, runtimeRole, namespace, metadataNamespace },
        () => {
          wakes++;
        },
      );
      await listener.ready;
      expect(wakes).toBe(1);
      const revision = async () =>
        (
          await admin.query<{ revision: string }>(
            `SELECT revision::text FROM "${metadataNamespace}".table_revisions WHERE namespace=$1`,
            [namespace],
          )
        ).rows[0]?.revision;
      await admin.query("BEGIN");
      await admin.query(`INSERT INTO "${namespace}".tasks VALUES (1)`);
      await admin.query("ROLLBACK");
      await Bun.sleep(20);
      expect(wakes).toBe(1);
      expect(await revision()).toBe("1");
      await admin.query(`INSERT INTO "${namespace}".tasks VALUES (1)`);
      await waitFor(() => wakes === 2);
      expect(await revision()).toBe("2");
      await admin.query(`DELETE FROM "${namespace}".tasks`);
      await waitFor(() => wakes === 3);
      await admin.query(`TRUNCATE "${namespace}".tasks`);
      await waitFor(() => wakes === 4);
      expect(await revision()).toBe("4");
      await admin.query("SELECT pg_notify($1,$2)", [
        revisionNotificationChannel(metadataNamespace, namespace),
        '{"identity":"forged","revision":999}',
      ]);
      await waitFor(() => wakes === 5);
      expect(await revision()).toBe("4");
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1", [runtimeRole]);
      await waitFor(() => statuses.includes("degraded"));
      await waitFor(() => statuses.filter((event) => event === "connected").length === 2);
      const before = wakes;
      await admin.query(`INSERT INTO "${namespace}".tasks VALUES (2)`);
      await waitFor(() => wakes > before);
      expect(await revision()).toBe("5");
      await listener.stop();
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=$1", [runtimeRole]))
          .rows[0]?.count,
      ).toBe(0);
      const pooled = new URL(address);
      pooled.hostname = "ep-test-pooler.us-east-1.aws.neon.tech";
      expect(() =>
        listenForRevisions({ connectionString: pooled.href, runtimeRole, namespace, metadataNamespace }, () => {}),
      ).toThrow(/direct runtime/);
      const owner = new URL(connectionString);
      const connected = statuses.filter((status) => status === "connected").length;
      const unsafe = listenForRevisions(
        { connectionString, runtimeRole: decodeURIComponent(owner.username), namespace, metadataNamespace },
        () => {},
      );
      try {
        await unsafe.ready;
        expect(statuses.at(-1)).toBe("degraded");
        expect(statuses.filter((status) => status === "connected")).toHaveLength(connected);
      } finally {
        await unsafe.stop();
      }
    } finally {
      await listener?.stop();
      metric.unsubscribe(record);
      await admin.query("ROLLBACK");
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
  120000,
);
