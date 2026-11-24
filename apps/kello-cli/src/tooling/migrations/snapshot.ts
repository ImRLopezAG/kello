import * as v from "valibot";

const name = v.pipe(v.string(), v.minLength(1), v.maxLength(63));
const qualified = { schema: name, name };
const columnOwner = { schema: name, table: name, name };
const namedConstraint = { ...columnOwner, nameExplicit: v.boolean(), columns: v.array(name) };
const action = v.nullable(v.picklist(["NO ACTION", "CASCADE", "SET NULL", "SET DEFAULT", "RESTRICT"]));

/** The pinned Drizzle snapshot subset emitted by Kello's supported storage vocabulary. */
export const snapshotValidator = v.strictObject({
  version: v.literal("8"),
  dialect: v.literal("postgres"),
  id: v.string(),
  prevIds: v.array(v.string()),
  renames: v.array(v.string()),
  ddl: v.array(
    v.variant("entityType", [
      v.strictObject({ entityType: v.literal("schemas"), name }),
      v.strictObject({ entityType: v.literal("tables"), ...qualified, isRlsEnabled: v.boolean() }),
      v.strictObject({
        entityType: v.literal("columns"),
        ...columnOwner,
        type: v.string(),
        typeSchema: v.nullable(v.string()),
        notNull: v.boolean(),
        dimensions: v.pipe(v.number(), v.integer()),
        default: v.nullable(v.string()),
        generated: v.null(),
        identity: v.null(),
      }),
      v.strictObject({
        entityType: v.literal("indexes"),
        ...columnOwner,
        nameExplicit: v.boolean(),
        columns: v.array(
          v.strictObject({
            value: v.string(),
            isExpression: v.boolean(),
            asc: v.boolean(),
            nullsFirst: v.boolean(),
            opclass: v.nullable(v.strictObject({ name: v.string(), default: v.boolean() })),
          }),
        ),
        isUnique: v.boolean(),
        where: v.nullable(v.string()),
        with: v.string(),
        method: v.string(),
        concurrently: v.boolean(),
      }),
      v.strictObject({
        entityType: v.literal("fks"),
        ...namedConstraint,
        schemaTo: name,
        tableTo: name,
        columnsTo: v.array(name),
        onUpdate: action,
        onDelete: action,
      }),
      v.strictObject({ entityType: v.literal("pks"), ...namedConstraint }),
      v.strictObject({ entityType: v.literal("uniques"), ...namedConstraint, nullsNotDistinct: v.boolean() }),
      v.strictObject({ entityType: v.literal("checks"), ...columnOwner, value: v.string() }),
    ]),
  ),
});

/** RC6 emits v10 states, whose indexes no longer carry `concurrently`. Kello keeps its
 * persisted v8 storage contract and hash domain, so the field is restored as `false`:
 * native index builds always run inside the migration transaction, and Kello's own
 * nontransactional artifacts remain the only route to concurrent builds. The restricted
 * entity vocabulary is unchanged; validate the native envelope before conversion. This
 * leaves committed plans, SQL, lineage and deployed ledger IDs intact.
 */
const [schemas, tables, columns, indexes, ...constraints] = snapshotValidator.entries.ddl.item.options;
const { concurrently: _concurrently, ...nativeIndex } = indexes.entries;
const nativeEntity = v.variant("entityType", [schemas, tables, columns, v.strictObject(nativeIndex), ...constraints]);

// This function is the schema-validation boundary for untrusted Kit output.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function fromDrizzleSnapshot(input: unknown): v.InferOutput<typeof snapshotValidator> {
  const { renames: _renames, ddl: _ddl, ...entries } = snapshotValidator.entries;
  const snapshot = v.parse(v.strictObject({ ...entries, version: v.literal("10"), ddl: v.array(nativeEntity) }), input);
  const ddl = snapshot.ddl.map((entity) =>
    entity.entityType === "indexes" ? { ...entity, concurrently: false } : entity,
  );
  return v.parse(snapshotValidator, { ...snapshot, version: "8", renames: [], ddl });
}
