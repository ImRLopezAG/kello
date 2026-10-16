import type { SchemaMetadata } from "./compile";

/** Bootstrap statements run by migration credentials, never on request startup. */
export function systemFieldSql(metadata: SchemaMetadata): readonly string[] {
  const namespace = quoteIdentifier(metadata.namespace);
  const functionName = `${namespace}."loom_protect_system_fields"`;
  return [
    `CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog AS $kello$
      BEGIN
        IF NEW."_id" IS DISTINCT FROM OLD."_id" OR NEW."_createdAt" IS DISTINCT FROM OLD."_createdAt" THEN
          RAISE EXCEPTION 'Kello system fields are immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $kello$`,
    ...metadata.entities.flatMap((entity) => {
      const table = `${namespace}.${quoteIdentifier(entity.sqlName)}`;
      return [
        `DROP TRIGGER IF EXISTS "loom_protect_system_fields" ON ${table}`,
        `CREATE TRIGGER "loom_protect_system_fields" BEFORE UPDATE ON ${table}
         FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      ];
    }),
  ];
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
