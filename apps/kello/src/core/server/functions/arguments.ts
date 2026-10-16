import * as v from "valibot";
import type { StandardSchemaV1 } from "@standard-schema/spec";

export type ArgumentDeclaration = StandardSchemaV1 | Readonly<Record<string, StandardSchemaV1>>;
export type ArgumentSchema<Args extends ArgumentDeclaration> = Args extends StandardSchemaV1
  ? Args
  : StandardSchemaV1<
      { [Key in keyof Args]: Args[Key] extends StandardSchemaV1 ? StandardSchemaV1.InferInput<Args[Key]> : never },
      { [Key in keyof Args]: Args[Key] extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<Args[Key]> : never }
    >;

export function argumentSchema(declaration: ArgumentDeclaration = {}): StandardSchemaV1 {
  if ("~standard" in declaration && "validate" in declaration["~standard"]) {
    // SAFETY: Standard Schema declarations expose their validator through ~standard.
    return declaration as StandardSchemaV1;
  }
  const entries = Object.entries(declaration);
  const names = new Set(entries.map(([name]) => name));
  return {
    "~standard": {
      version: 1,
      vendor: "loom-arguments",
      async validate(input) {
        const parsed = v.safeParse(v.record(v.string(), v.unknown()), input);
        if (!parsed.success) return { issues: [{ message: "Expected an argument object" }] };
        const output: Record<string, StandardSchemaV1.InferOutput<StandardSchemaV1>> = {};
        const issues: StandardSchemaV1.Issue[] = [];
        for (const name of Object.keys(parsed.output)) {
          if (!names.has(name)) issues.push({ message: "Unknown argument", path: [name] });
        }
        for (const [name, schema] of entries) {
          const result = await schema["~standard"].validate(parsed.output[name]);
          if (result.issues) {
            for (const issue of result.issues) issues.push({ ...issue, path: [name, ...(issue.path ?? [])] });
          } else Object.defineProperty(output, name, { value: result.value, enumerable: true });
        }
        return issues.length ? { issues } : { value: output };
      },
    },
  };
}
