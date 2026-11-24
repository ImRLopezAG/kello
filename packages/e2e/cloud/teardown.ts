import * as pg from "../fixtures/postgres";
import { planTeardown, teardownStatements, type TeardownPlan } from "./lifecycle";

/**
 * Removes acceptance leftovers in a safe order: Neon functions (and with them their wake
 * triggers) first so nothing reconnects, then schemas, then roles. Returns the labels of steps that
 * failed; provider/driver messages are never surfaced because they can contain credentials.
 */
export async function executeTeardown(
  input: TeardownPlan,
  options: { deleteFunction: (slug: string) => Promise<string>; connectionString: string },
): Promise<string[]> {
  const plan = planTeardown(input);
  const failures: string[] = [];
  for (const slug of plan.functions) {
    try {
      await options.deleteFunction(slug);
    } catch {
      failures.push(`function ${slug}`);
    }
  }
  if (!plan.schemas.length && !plan.roles.length) return failures;
  const client = new pg.Client({ connectionString: options.connectionString, connectionTimeoutMillis: 15000 });
  try {
    await client.connect();
    const existing = await client.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
      [plan.roles],
    );
    const roles = existing.rows.map((row) => row.rolname);
    for (const schema of plan.schemas) {
      try {
        for (const sql of teardownStatements({ functions: [], schemas: [schema], roles: [] })) await client.query(sql);
      } catch {
        failures.push(`schema ${schema}`);
      }
    }
    for (const role of roles) {
      const statements = teardownStatements({ functions: [], schemas: [], roles: [role] });
      // Neon's owner role may not REASSIGN/DROP OWNED (42501) but can drop a role whose schemas are gone;
      // try the bare DROP ROLE first and fall back to the full sequence only when objects remain.
      let dropped = false;
      for (const attempt of [statements.slice(-1), statements]) {
        try {
          await client.query("BEGIN");
          for (const sql of attempt) await client.query(sql);
          await client.query("COMMIT");
          dropped = true;
          break;
        } catch {
          await client.query("ROLLBACK").catch(() => {});
        }
      }
      if (!dropped) failures.push(`role ${role}`);
    }
  } catch {
    failures.push("database connection");
  } finally {
    await client.end().catch(() => {});
  }
  return failures;
}
