import { OpenAPIGenerator, OpenAPIGeneratorError } from "@orpc/openapi";
import type { OpenAPIGeneratorOptions, OpenAPIGeneratorGenerateOptions, OpenAPIDocument } from "@orpc/openapi";
import { ValibotToJsonSchemaConverter } from "@orpc/valibot";
import { Schema } from "effect";
import type { AnyRouter } from "@orpc/server";
import type { AnySchema } from "@orpc/contract";
import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import * as v from "valibot";
import { rpcErrorStatusMap } from "./error-status";

type Converter = NonNullable<OpenAPIGeneratorOptions["converters"]>[number];

function hasJsonSchema(schema: AnySchema | undefined): schema is AnySchema & StandardJSONSchemaV1 {
  return v.is(
    v.object({
      "~standard": v.object({ jsonSchema: v.object({ input: v.function(), output: v.function() }) }),
    }),
    schema,
  );
}

/** Precise OpenAPI export requires explicit output schemas. Native generation
 * supplies path-aware diagnostics; its permissive unknown-schema fallback is disabled. */
export function generateRpcOpenAPI(
  router: AnyRouter,
  options: OpenAPIGeneratorGenerateOptions<"3.2.0"> = {},
): Promise<OpenAPIDocument<"3.2.0">> {
  const converters: Converter[] = [
    new ValibotToJsonSchemaConverter({ errorMode: "throw" }),
    {
      condition: (schema) => Schema.isSchema(schema),
      convert(schema, direction) {
        if (!Schema.isSchema(schema)) throw new TypeError("Expected Effect Schema");
        // The upstream wrapper swallows conversion errors into {}. Invoke Effect's
        // public converter directly so unsupported schemas fail generation.
        const standard = Schema.toStandardJSONSchemaV1(schema)["~standard"];
        const result = standard.jsonSchema[direction]({ target: "draft-2020-12" });
        const validation = schema["~standard"].validate(undefined);
        const optional = !(validation instanceof Promise) && !validation.issues;
        return [result, optional];
      },
    },
    {
      condition: hasJsonSchema,
      convert(schema, direction) {
        if (!hasJsonSchema(schema)) throw new TypeError("Expected Standard JSON Schema");
        // Do not use upstream's fallback-to-{} conversion: unsupported public
        // contracts must fail generation instead of becoming unconstrained.
        const result = schema["~standard"].jsonSchema[direction]({ target: "draft-2020-12" });
        let optional = false;
        try {
          const validation = schema["~standard"].validate(undefined);
          if (validation instanceof Promise) void validation.catch(() => undefined);
          else optional = !validation.issues && (direction === "input" || validation.value === undefined);
        } catch {
          // A transform may throw for undefined while accepting valid input.
          optional = false;
        }
        return [result, optional];
      },
    },
  ];
  const strict: Converter = {
    condition: () => true,
    convert(schema, direction) {
      if (schema === undefined) return [{}, true];
      const converter = converters.find((candidate) => candidate.condition(schema, direction));
      if (!converter)
        throw new OpenAPIGeneratorError(`Unsupported ${direction} schema vendor: ${schema["~standard"].vendor}`);
      try {
        return converter.convert(schema, direction);
      } catch {
        throw new OpenAPIGeneratorError(
          `Unsupported ${direction} schema conversion; supply a representable public contract`,
        );
      }
    },
  };
  return new OpenAPIGenerator({ converters: [strict] }).generate(router, {
    errorStatusMap: rpcErrorStatusMap,
    ...options,
    filter(contract, path) {
      const include = v.is(v.function(), options.filter) ? options.filter(contract, path) : options.filter;
      if (include === false) return false;
      const outputs = contract["~orpc"].outputSchemas;
      if (!outputs || (Array.isArray(outputs) && outputs.length === 0)) {
        throw new OpenAPIGeneratorError(`Procedure at ${path.join(".") || "(root)"}: explicit output schema required`);
      }
      return true;
    },
  });
}
