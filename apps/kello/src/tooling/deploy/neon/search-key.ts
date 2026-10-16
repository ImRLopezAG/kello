import { randomBytes } from "node:crypto";
import type pg from "pg";
import * as v from "valibot";
import { databaseIdentifier, quoteIdentifier } from "../../migrations/connection";

const optionsSchema = v.strictObject({
  metadataNamespace: databaseIdentifier,
  projectId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  branchId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});

/** Only the metadata owner provisions secrets; release versions and auth keys are independent. */
export async function provisionSearchCursorKey(client: pg.Client, input: v.InferInput<typeof optionsSchema>) {
  const options = v.parse(optionsSchema, input);
  const ownership = await client.query<{ owned: boolean }>(
    "SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned FROM pg_namespace WHERE nspname=$1",
    [options.metadataNamespace],
  );
  if (ownership.rows[0]?.owned !== true) throw new Error("Cursor key provisioning requires the metadata owner");
  const result = await client.query<{ key: string }>(
    `INSERT INTO ${quoteIdentifier(options.metadataNamespace)}.search_cursor_keys(project_id,branch_id,key)
     VALUES($1,$2,$3) ON CONFLICT(project_id,branch_id) DO UPDATE SET key=search_cursor_keys.key RETURNING key`,
    [options.projectId, options.branchId, randomBytes(32).toString("hex")],
  );
  const key = result.rows[0]?.key;
  if (!v.is(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)), key)) throw new Error("Invalid provisioned cursor key");
  return key;
}
