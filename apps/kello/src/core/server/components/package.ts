import * as v from "valibot";
import type { ComponentDefinition } from "./definition";

const entry = v.pipe(v.string(), v.regex(/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w][\w.-]*)*$/));
const modulePath = v.pipe(v.string(), v.regex(/^[A-Za-z][\w-]*(?:\/[A-Za-z][\w-]*)*\.[cm]?js$/));
const descriptorSchema = v.strictObject({
  formatVersion: v.literal(1),
  definitionVersion: v.pipe(v.string(), v.minLength(1)),
  entry,
  schema: v.optional(entry),
  relations: v.optional(entry),
  crons: v.optional(entry),
  storage: v.optional(entry),
  rateLimits: v.optional(entry),
  contractRegistry: entry,
  contracts: v.array(v.strictObject({ path: modulePath, entry })),
  procedures: v.array(v.strictObject({ path: modulePath, entry, visibility: v.picklist(["public", "internal"]) })),
  bindings: v.strictObject({
    setup: v.optional(entry),
    rpc: v.optional(entry),
    server: v.optional(entry),
    schema: v.optional(entry),
    contract: v.optional(entry),
    contracts: v.optional(v.record(v.string(), entry)),
  }),
});

/** Published ESM entry points. Keep generated facades as separate compiled modules. */
type ParsedDescriptor = v.InferOutput<typeof descriptorSchema>;
export type ComponentPackageDescriptor = Readonly<Omit<ParsedDescriptor, "contracts" | "procedures">> & {
  readonly contracts: readonly Readonly<ParsedDescriptor["contracts"][number]>[];
  readonly procedures: readonly Readonly<ParsedDescriptor["procedures"][number]>[];
};
const descriptors = new WeakMap<ComponentDefinition, ComponentPackageDescriptor>();

/** Attach a serializable package manifest without changing the definition's inferred API. */
export function defineComponentPackage<const Definition extends ComponentDefinition>(
  definition: Definition,
  descriptor: ComponentPackageDescriptor,
): Definition {
  if (descriptors.has(definition)) throw new Error("Component already has a package descriptor");
  if (descriptor.formatVersion !== 1) throw new Error("Unsupported Kello component package descriptor version");
  const validated = v.parse(descriptorSchema, descriptor);
  const frozen = Object.freeze({
    ...validated,
    contracts: Object.freeze(validated.contracts.map((module) => Object.freeze(module))),
    procedures: Object.freeze(validated.procedures.map((module) => Object.freeze(module))),
    bindings: Object.freeze({ ...validated.bindings, contracts: Object.freeze(validated.bindings.contracts ?? {}) }),
  });
  descriptors.set(definition, frozen);
  return definition;
}

export function getComponentPackage(definition: ComponentDefinition): ComponentPackageDescriptor | undefined {
  return descriptors.get(definition);
}
