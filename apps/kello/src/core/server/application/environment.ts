import type { StandardSchemaV1 } from "@standard-schema/spec";

/** Server environment declarations keyed by variable name. Each value is a Standard Schema validator; Zod and Valibot are both supported. */
export type ApplicationEnvironment = Readonly<Record<string, StandardSchemaV1>>;
/** Validated outputs of an environment declaration, including schema transformations. Available in the active server scope; never expose this object to clients. */
export type ApplicationEnvironmentOutput<Env extends ApplicationEnvironment> = {
  readonly [Key in keyof Env]: StandardSchemaV1.InferOutput<Env[Key]>;
};

const environmentValue: unique symbol = Symbol("Kello environment value");
/** Typed configuration-time reference to a parent environment variable. It contains a key and a phantom value type, not the resolved secret. */
export interface EnvironmentReference<Value = unknown> {
  readonly key: string;
  readonly [environmentValue]: Value;
}
/** References used to bind a parent application environment to a mounted component without copying secrets into configuration. */
export type EnvironmentReferences<Env extends ApplicationEnvironment> = {
  readonly [Key in keyof Env]: EnvironmentReference<StandardSchemaV1.InferOutput<Env[Key]>>;
};
const references = new WeakSet<object>();

export function environmentAccess<Env extends ApplicationEnvironment>(
  declaration: Env,
  read: () => ApplicationEnvironmentOutput<Env>,
): ApplicationEnvironmentOutput<Env> {
  const access: Partial<ApplicationEnvironmentOutput<Env>> = {};
  for (const key of Object.keys(declaration)) {
    Object.defineProperty(access, key, { enumerable: true, get: () => read()[key] });
  }
  // SAFETY: every declared key has a getter resolving the validated active scope.
  return Object.freeze(access) as ApplicationEnvironmentOutput<Env>;
}

export function createEnvironmentReferences<const Env extends ApplicationEnvironment>(declaration: Env) {
  const entries = Object.keys(declaration).map((key) => {
    const reference = Object.freeze({ key });
    references.add(reference);
    return [key, reference];
  });
  // SAFETY: references are created for exactly the declaration's own keys;
  // their phantom value type records the schema output without reading secrets.
  return Object.freeze(Object.fromEntries(entries)) as EnvironmentReferences<Env>;
}

export function validateEnvironmentReference(
  reference: EnvironmentReference,
  parent: Readonly<Record<string, EnvironmentReference>>,
): void {
  if (!references.has(reference) || !Object.hasOwn(parent, reference.key) || parent[reference.key] !== reference) {
    throw new Error("Invalid environment reference for this component parent");
  }
}

/** Validate only declared server variables. Never retain vendor errors: they can
 * contain credentials, input values, or arbitrary application exceptions. */
export async function parseApplicationEnvironment<const Env extends ApplicationEnvironment>(
  declaration: Env,
  source: Readonly<Record<string, string | undefined>>,
): Promise<ApplicationEnvironmentOutput<Env>> {
  const output: Partial<ApplicationEnvironmentOutput<Env>> = {};
  for (const [name, schema] of Object.entries(declaration)) {
    try {
      const result = await schema["~standard"].validate(Object.hasOwn(source, name) ? source[name] : undefined);
      if (result.issues) throw new Error("Validation failed");
      Object.defineProperty(output, name, { value: result.value, enumerable: true });
    } catch {
      throw new Error(`Invalid application environment variable: ${name}`);
    }
  }
  // SAFETY: each declared key was validated by its own Standard Schema above.
  return Object.freeze(output) as ApplicationEnvironmentOutput<Env>;
}
