import { AsyncLocalStorage } from "node:async_hooks";
import * as v from "valibot";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ApplicationEnvironment, ApplicationEnvironmentOutput } from "../application/environment";
import { environmentAccess } from "../application/environment";
import type { ComponentDefinition } from "./definition";
import type { ComponentServiceFactory } from "./services";
import type { ComponentGraph } from "./graph";

export type PreparedComponentServiceFactory = (
  components: Readonly<Record<string, { readonly services: object }>>,
) => ReturnType<ComponentServiceFactory>;

interface ComponentEnvironment {
  readonly definition: ComponentDefinition;
  readonly env: ApplicationEnvironmentOutput<ApplicationEnvironment>;
  readonly options: unknown;
}
const scope = new AsyncLocalStorage<ComponentEnvironment>();

type DeclaredEnvironment<Definition extends ComponentDefinition> =
  Definition["environmentSchema"] extends ApplicationEnvironment
    ? Definition["environmentSchema"]
    : Record<never, never>;

export function readComponentEnvironment<const Env extends ApplicationEnvironment>(
  definition: ComponentDefinition & { readonly environmentSchema: Env },
): ApplicationEnvironmentOutput<Env>;
export function readComponentEnvironment<const Definition extends ComponentDefinition>(
  definition: Definition,
): ApplicationEnvironmentOutput<DeclaredEnvironment<Definition>>;
export function readComponentEnvironment(definition: ComponentDefinition) {
  const current = scope.getStore();
  if (!current || current.definition !== definition) throw new Error("Component environment is unavailable");
  // SAFETY: initialization validates every declaration for this exact definition.
  return current.env;
}

/** Defer declaration binding while every value getter still reads the active invocation. */
export function deferEnvironmentAccess<Env extends ApplicationEnvironment>(
  read: () => ApplicationEnvironmentOutput<Env>,
): ApplicationEnvironmentOutput<Env> {
  let access: ApplicationEnvironmentOutput<Env> | undefined;
  const resolve = () => (access ??= read());
  // SAFETY: every property and declared key is forwarded to the same validated environment facade.
  return new Proxy({} as ApplicationEnvironmentOutput<Env>, {
    get: (_target, key) => {
      const values: ApplicationEnvironmentOutput<ApplicationEnvironment> = resolve();
      return v.is(v.string(), key) ? values[key] : undefined;
    },
    has: (_target, key) => Reflect.has(resolve(), key),
    ownKeys: () => Reflect.ownKeys(resolve()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), key);
      return descriptor && { ...descriptor, configurable: true };
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}

export function createComponentEnvironmentAccess<const Definition extends ComponentDefinition>(
  definition: Definition | (() => Definition),
): ApplicationEnvironmentOutput<DeclaredEnvironment<Definition>> {
  if (v.is(v.function(), definition))
    return deferEnvironmentAccess(() => createComponentEnvironmentAccess(definition()));
  // SAFETY: an omitted schema is precisely the empty declaration in DeclaredEnvironment.
  const declaration = (definition.environmentSchema ?? {}) as DeclaredEnvironment<Definition>;
  return environmentAccess(declaration, () => readComponentEnvironment(definition));
}

export function readComponentOptions<const Definition extends ComponentDefinition>(definition: Definition) {
  const current = scope.getStore();
  if (!current || current.definition !== definition) throw new Error("Component options are unavailable");
  // SAFETY: initialization validates options against this definition's schema.
  return current.options as NonNullable<Definition["options"]> extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<NonNullable<Definition["options"]>>
    : undefined;
}

export async function prepareComponentEnvironments(
  graph: ComponentGraph,
  applicationEnv: ApplicationEnvironmentOutput<ApplicationEnvironment>,
  source: Readonly<Record<string, string | undefined>>,
) {
  const instances = new Map<string, ComponentEnvironment>();
  for (const node of graph.nodes) {
    const parentPath = node.path.slice(0, node.path.lastIndexOf("/") + 1).replace(/\/$/, "");
    const parent = parentPath ? instances.get(parentPath)?.env : applicationEnv;
    if (!parent) throw new Error(`Missing component parent: ${node.path}`);
    const env: ApplicationEnvironmentOutput<ApplicationEnvironment> = {};
    for (const [key, validator] of Object.entries(node.definition.environmentSchema ?? {})) {
      const binding = node.env[key];
      const value = binding ? parent[binding.key] : Object.hasOwn(source, key) ? source[key] : undefined;
      try {
        const result = await validator["~standard"].validate(value);
        if (result.issues) throw new Error("Validation failed");
        Object.defineProperty(env, key, { value: result.value, enumerable: true });
      } catch {
        throw new Error(`Invalid component environment variable: ${node.path}.${key}`);
      }
    }
    let options: unknown;
    try {
      const validator = node.definition.options;
      if (validator) {
        const result = await validator["~standard"].validate(node.options);
        if (result.issues) throw new Error("Validation failed");
        options = result.value;
      } else if (node.options !== undefined) {
        throw new Error("Undeclared options");
      }
    } catch {
      throw new Error(`Invalid component options: ${node.path}`);
    }
    instances.set(node.path, Object.freeze({ definition: node.definition, env: Object.freeze(env), options }));
  }
  const serviceFactories: Record<string, PreparedComponentServiceFactory> = {};
  for (const [path, instance] of instances) {
    if (!instance.definition.services) continue;
    // SAFETY: this instance's env/options were validated against this exact definition above.
    const factory = instance.definition.services as (configuration: {
      readonly components: Readonly<Record<string, { readonly services: object }>>;
      readonly env: typeof instance.env;
      readonly options: typeof instance.options;
    }) => ReturnType<ComponentServiceFactory>;
    Object.defineProperty(serviceFactories, path, {
      enumerable: true,
      value: (components: Readonly<Record<string, { readonly services: object }>>) =>
        scope.run(instance, () => factory({ components, env: instance.env, options: instance.options })),
    });
  }
  return {
    serviceFactories: Object.freeze(serviceFactories),
    http: Object.freeze(
      [...instances]
        .filter(([, instance]) => instance.definition.http?.length)
        .map(([path, instance]) => ({
          scope: path,
          routes: instance.definition.http!,
          context: Object.freeze({ env: instance.env, options: instance.options }),
        })),
    ),
    runComponent<Result>(path: string, work: () => Result): Result {
      const instance = instances.get(path);
      if (!instance) throw new Error(`Unknown component instance: ${path}`);
      return scope.run(instance, work);
    },
  };
}
