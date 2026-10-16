import * as v from "valibot";
import { emptySnapshot, snapshotHash } from "../migrations/adapter";
import { databaseIdentifier } from "../migrations/connection";
import { readMigrations } from "../migrations/history";

const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const releaseSchemaRangeValidator = v.strictObject({
  minimum: hash,
  maximum: hash,
  target: hash,
  minimumMigration: v.optional(v.nullable(hash)),
  maximumMigration: v.optional(v.nullable(hash)),
});
const optionsValidator = v.strictObject({
  migrations: v.pipe(v.string(), v.minLength(1)),
  namespace: databaseIdentifier,
  migrationHashes: v.array(hash),
  schema: releaseSchemaRangeValidator,
});
export type ReleaseSchemaOptions = v.InferInput<typeof optionsValidator>;
export interface ReleaseSchemaInspection {
  readonly head: string;
  readonly minimumOrdinal: number;
  readonly maximumOrdinal: number;
  readonly schemas: readonly string[];
  readonly migrationHashes: readonly string[];
}

/** Validates a declared structural range against reviewed artifacts, not application behavior or live database state. */
export async function inspectReleaseSchema(
  root: string,
  input: ReleaseSchemaOptions,
): Promise<ReleaseSchemaInspection> {
  const parsed = v.safeParse(optionsValidator, structuredClone(input));
  if (!parsed.success) throw new Error("Invalid release schema input");
  const options = parsed.output;
  const artifacts = await readMigrations(root, options.migrations);
  const migrationHashes = artifacts.map((artifact) => artifact.plan.hash);
  if (JSON.stringify(migrationHashes) !== JSON.stringify(options.migrationHashes))
    throw new Error("Release migration history changed");
  for (const artifact of artifacts) {
    for (const snapshot of [artifact.plan.baseline, artifact.plan.snapshot]) {
      if (
        snapshot.ddl.some((entity) =>
          entity.entityType === "schemas"
            ? entity.name !== options.namespace
            : !("schema" in entity) || entity.schema !== options.namespace,
        )
      )
        throw new Error("Release migration escapes the selected namespace");
    }
  }
  const baseline = artifacts[0]?.plan.before ?? snapshotHash(await emptySnapshot(options.namespace));
  const lineage = [baseline, ...artifacts.map((artifact) => artifact.plan.after)];
  const head = lineage.at(-1) ?? baseline;
  if (options.schema.target !== head) throw new Error("Release target is not the committed schema head");
  function bound(schema: string, anchor: string | null | undefined, edge: "minimum" | "maximum"): number {
    if (anchor !== undefined) {
      const index = anchor === null ? 0 : migrationHashes.indexOf(anchor) + 1;
      if ((anchor !== null && index === 0) || lineage[index] !== schema)
        throw new Error("Release schema bounds do not match their migration anchors");
      return index;
    }
    const positions = lineage.flatMap((value, index) => (value === schema ? [index] : []));
    const first = positions.at(0);
    const last = positions.at(-1);
    if (first === undefined || last === undefined) throw new Error("Release schema bounds are absent");
    if (last - first + 1 !== positions.length)
      throw new Error("Release schema bounds are ambiguous; supply migration anchors");
    return edge === "minimum" ? first : last;
  }
  const minimum = bound(options.schema.minimum, options.schema.minimumMigration, "minimum");
  const maximum = bound(options.schema.maximum, options.schema.maximumMigration, "maximum");
  if (maximum < minimum) throw new Error("Release schema bounds are reversed");
  if (lineage.length - 1 > maximum) throw new Error("Release schema range excludes its target");
  const schemas = lineage
    .slice(minimum, maximum + 1)
    .filter((value, index, values) => index === 0 || value !== values[index - 1]);
  return Object.freeze({
    head,
    minimumOrdinal: minimum,
    maximumOrdinal: maximum,
    schemas: Object.freeze(schemas),
    migrationHashes: Object.freeze(migrationHashes),
  });
}
