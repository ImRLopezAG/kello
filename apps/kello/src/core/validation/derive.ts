import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as v from "valibot";
import type { SchemaMetadata } from "../schema/compile";
import { TableDefinition } from "../schema/table";
import type { EntityDeclaration } from "../schema/table";
import { storageParser, systemParsers } from "./encoding";
import type { StorageRow } from "./encoding";
import type { SchemaValidators } from "./types";

type Boundary = "storage" | "insert" | "patch" | "command" | "public";
const objectInput = v.record(v.string(), v.unknown());
interface RuntimeValidators extends Record<Boundary, StandardSchemaV1<StorageRow>> {}

export function derive<const Entities extends Record<string, EntityDeclaration>>(
  entities: Entities,
  metadata: SchemaMetadata,
) {
  const validators: Record<string, RuntimeValidators> = {};
  for (const entity of metadata.entities) {
    const declaration = entities[entity.name];
    if (!declaration) throw new Error(`Missing validator declaration: ${entity.name}`);
    const fields = declaration instanceof TableDefinition ? declaration.fields : declaration;
    const fieldEntries = entity.fields.map((field) => ({
      ...field,
      parser: storageParser(field),
      validator: fields[field.name]?.validator,
    }));
    const server = new Set(entity.options.serverFields ?? []);
    const command = new Set(entity.options.commandFields ?? []);
    const publicFields = new Set(entity.options.publicFields ?? []);
    function crossValidation(kind: Boundary) {
      if (!(declaration instanceof TableDefinition)) return undefined;
      if (kind === "insert") return declaration.options.insertValidation;
      if (kind === "patch") return declaration.options.patchValidation;
      return undefined;
    }
    function boundary(kind: Boundary, stage: "input" | "normalized" = "input"): StandardSchemaV1<StorageRow> {
      const selected = fieldEntries.filter((field) => {
        if (kind === "public") return publicFields.has(field.name);
        if (kind === "command") return command.has(field.name) && !server.has(field.name);
        return kind === "storage" || !server.has(field.name);
      });
      const allowed = new Set(selected.map((field) => field.name));
      if (kind === "storage") {
        allowed.add("_id");
        allowed.add("_createdAt");
      }
      if (kind === "public") for (const key of publicFields) allowed.add(key);
      return {
        "~standard": {
          version: 1,
          vendor: "kello",
          async validate(value) {
            const object = v.safeParse(objectInput, value);
            if (!object.success) return { issues: [{ message: "Expected a record" }] };
            const input = object.output;
            const issues: StandardSchemaV1.Issue[] = [];
            const output: StorageRow = {};
            if (kind !== "public")
              for (const key of Object.keys(input)) {
                if (!allowed.has(key)) issues.push({ message: "Field is not allowed", path: [key] });
              }
            for (const field of selected) {
              const present = Object.hasOwn(input, field.name);
              const required =
                kind === "storage" ||
                kind === "public" ||
                (kind !== "patch" && field.notNull && field.defaultValue === undefined);
              if (!present && kind === "patch") continue;
              if (!present && (kind === "storage" || kind === "public")) {
                issues.push({ message: "Required field", path: [field.name] });
                continue;
              }
              let normalized = input[field.name];
              if (present && normalized === undefined && kind === "patch") {
                issues.push({ message: "Use omission for unchanged fields", path: [field.name] });
                continue;
              }
              if (
                stage === "input" &&
                field.validator &&
                kind !== "storage" &&
                kind !== "public" &&
                normalized !== null
              ) {
                const checked = await field.validator["~standard"].validate(normalized);
                if (checked.issues) {
                  if (present || required)
                    issues.push(
                      ...checked.issues.map((issue) => ({
                        message: issue.message,
                        path: [field.name, ...(issue.path ?? [])],
                      })),
                    );
                  continue;
                }
                normalized = checked.value;
              }
              if (!present && normalized === undefined) {
                if (required) issues.push({ message: "Required field", path: [field.name] });
                continue;
              }
              const stored = v.safeParse(field.parser, normalized);
              if (!stored.success) {
                issues.push({ message: "Value does not fit storage", path: [field.name] });
                continue;
              }
              output[field.name] = stored.output;
            }
            if (kind === "storage" || kind === "public") {
              for (const [key, parser] of Object.entries(systemParsers)) {
                if (!allowed.has(key)) continue;
                const stored = v.safeParse(parser, input[key]);
                if (stored.success) output[key] = stored.output;
                else issues.push({ message: "Invalid system field", path: [key] });
              }
            }
            if (issues.length) return { issues };
            const crossValidator = crossValidation(kind);
            if (stage === "input" && crossValidator) {
              const supplied = new Set(Object.keys(output));
              const checked = await crossValidator["~standard"].validate(output);
              if (checked.issues) return { issues: checked.issues };
              const normalized = await boundary(kind, "normalized")["~standard"].validate(checked.value);
              if (normalized.issues) return normalized;
              if (kind === "patch" && Object.keys(normalized.value).some((key) => !supplied.has(key))) {
                return { issues: [{ message: "Patch validation cannot populate omitted fields" }] };
              }
              return normalized;
            }
            return { value: output };
          },
        },
      };
    }
    validators[entity.name] = Object.freeze({
      storage: boundary("storage"),
      insert: boundary("insert"),
      patch: boundary("patch"),
      command: boundary("command"),
      public: boundary("public"),
    });
  }
  // SAFETY: every schema entity is visited and each boundary enforces its matching metadata mask and native storage types.
  return Object.freeze(validators) as SchemaValidators<Entities>;
}
