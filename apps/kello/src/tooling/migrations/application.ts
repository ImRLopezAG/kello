import type pg from "pg";
import { systemFieldSql } from "kello/server";
import { quoteIdentifier } from "./connection";
import { installRevisionTracking } from "./revisions";

/** Install the same system-field protections and runtime grants for release and development DDL. */
export async function protectApplication(
  client: pg.Client,
  namespace: string,
  runtimeRole: string,
  tables: readonly string[],
  metadataNamespace: string,
): Promise<void> {
  const entities = tables.map((name) => ({ name, sqlName: name, fields: [], options: {} }));
  for (const statement of systemFieldSql({ namespace, entities })) await client.query(statement);
  await installRevisionTracking(client, namespace, metadataNamespace, tables);
  const application = quoteIdentifier(namespace);
  const role = quoteIdentifier(runtimeRole);
  await client.query(`REVOKE ALL ON SCHEMA ${application} FROM PUBLIC, ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA ${application} TO ${role}`);
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${application} FROM PUBLIC, ${role}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${application} TO ${role}`);
  await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${application} FROM PUBLIC, ${role}`);
  await client.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${application} TO ${role}`);
  await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${application} FROM PUBLIC, ${role}`);
}
