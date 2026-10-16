import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ComponentDescriptor, ComponentDefinition } from "./definition";
import { validateEnvironmentReference } from "../application/environment";
import type { EnvironmentReference } from "../application/environment";

const referenceType: unique symbol = Symbol("Kello component reference");
/** Handle returned by app.use(). Identifies a mounted instance for dependency binding; it is not a runtime SDK client. */
export interface ComponentReference<Definition extends ComponentDescriptor = ComponentDescriptor> {
  readonly name: string;
  readonly [referenceType]: Definition;
}

type OptionInput<Definition extends ComponentDescriptor> =
  NonNullable<Definition["options"]> extends never
    ? undefined
    : NonNullable<Definition["options"]> extends StandardSchemaV1
      ? StandardSchemaV1.InferInput<NonNullable<Definition["options"]>>
      : undefined;

type MountConfiguration<Definition extends ComponentDescriptor> = {
  readonly name?: string;
  /** Explicit root namespace for this instance's exported RPCs. Omit for backend-only use. */
  readonly public?: string;
  readonly dependencies?: Readonly<Record<string, ComponentReference>>;
  readonly env?: {
    readonly [Key in keyof NonNullable<Definition["environmentSchema"]>]?: EnvironmentReference<
      StandardSchemaV1.InferInput<NonNullable<Definition["environmentSchema"]>[Key]>
    >;
  };
} & (undefined extends OptionInput<Definition>
  ? { readonly options?: OptionInput<Definition> }
  : { readonly options: OptionInput<Definition> });

type MountArguments<Definition extends ComponentDescriptor> =
  undefined extends OptionInput<Definition>
    ? [configuration?: MountConfiguration<Definition>]
    : [configuration: MountConfiguration<Definition>];

/** Explicit component mounting API shared by applications and components. Mount names determine persistent namespaces; treat renaming as a migration decision. */
export interface ComponentHost {
  /** Mount an instance explicitly; returns its dependency reference. Omit public to keep exported RPCs backend-only. */
  use<const Definition extends ComponentDefinition>(
    this: void,
    definition: Definition,
    ...args: MountArguments<Definition>
  ): ComponentReference<Definition>;
}

/** Resolved component registration with its full mount path. Used by generation and runtime assembly. */
export interface ComponentNode extends Registration {
  readonly path: string;
}

/** Resolved component mount graph consumed by generation and runtime assembly. */
export interface ComponentGraph {
  readonly nodes: readonly ComponentNode[];
}

interface Registration {
  readonly public: string | undefined;
  readonly definition: ComponentDefinition;
  readonly reference: ComponentReference;
  readonly options: unknown;
  readonly dependencies: Readonly<Record<string, ComponentReference>>;
  readonly env: Readonly<Record<string, EnvironmentReference>>;
}
interface HostState {
  readonly registrations: Registration[];
  sealed: boolean;
  graph?: ComponentGraph;
}
const definitions = new WeakSet<object>();
const references = new WeakSet<object>();
const hosts = new WeakMap<ComponentHost["use"], HostState>();
const reservedNames = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "internal",
  "rpc",
  "services",
  "env",
  "options",
  "tables",
  "validators",
  "db",
  "components",
  "_generated",
]);

export function validateComponentName(name: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) || reservedNames.has(name)) {
    throw new Error(`Invalid component name: ${name}`);
  }
}

export function registerComponentDefinition(definition: ComponentDefinition): void {
  definitions.add(definition);
}

export function createComponentHost(parentEnv: Readonly<Record<string, EnvironmentReference>> = {}): ComponentHost {
  const state: HostState = { registrations: [], sealed: false };
  const use: ComponentHost["use"] = (definition, ...args) => {
    if (state.sealed) throw new Error("Component registrations are sealed");
    if (!definitions.has(definition)) throw new Error("Expected defineComponent's result");
    const configuration = args[0];
    const name = configuration?.name ?? definition.name;
    if (configuration?.public !== undefined) validateComponentName(configuration.public);
    validateComponentName(name);
    if (state.registrations.some((entry) => entry.reference.name === name)) {
      throw new Error(`Duplicate component name: ${name}`);
    }
    const dependencies = Object.freeze({ ...configuration?.dependencies });
    const env: Record<string, EnvironmentReference> = {};
    for (const [key, reference] of Object.entries(configuration?.env ?? {})) {
      if (!Object.hasOwn(definition.environmentSchema ?? {}, key)) {
        throw new Error(`Undeclared component environment variable: ${name}.${key}`);
      }
      if (!reference) throw new Error(`Invalid environment reference: ${name}.${key}`);
      validateEnvironmentReference(reference, parentEnv);
      Object.defineProperty(env, key, { value: reference, enumerable: true });
    }
    for (const [key, reference] of Object.entries(dependencies)) {
      validateComponentName(key);
      if (!references.has(reference)) throw new Error(`Invalid component reference: ${name}.${key}`);
    }
    // SAFETY: the private symbol carries only a compile-time capability type;
    // reference provenance is checked through the inaccessible WeakSet.
    const reference = Object.freeze({ name }) as ComponentReference<typeof definition>;
    references.add(reference);
    state.registrations.push({
      public: configuration?.public,
      definition,
      reference,
      options: configuration?.options,
      dependencies,
      env: Object.freeze(env),
    });
    return reference;
  };
  hosts.set(use, state);
  return { use };
}

/** Compile only explicitly registered definitions. A failed graph seals nothing. */
export function sealComponentGraph(host: ComponentHost): ComponentGraph {
  const root = hosts.get(host.use);
  if (!root) throw new Error("Expected a Kello component host");
  if (root.graph) return root.graph;
  const nodes: ComponentNode[] = [];
  const states = new Set<HostState>();
  function visit(state: HostState, parentPath: string, ancestors: ReadonlySet<ComponentDefinition>): void {
    states.add(state);
    const siblings = new Set(state.registrations.map((entry) => entry.reference));
    for (const entry of state.registrations) {
      if (parentPath && entry.public !== undefined)
        throw new Error("Public projections must be registered by the application");
      const path = parentPath ? `${parentPath}/${entry.reference.name}` : entry.reference.name;
      if (ancestors.has(entry.definition)) throw new Error(`Component cycle at ${path}`);
      for (const dependency of Object.values(entry.dependencies)) {
        if (!siblings.has(dependency) || dependency === entry.reference) {
          throw new Error(`Component dependency outside its scope at ${path}`);
        }
      }
      nodes.push(Object.freeze({ ...entry, path }));
      const child = hosts.get(entry.definition.use);
      if (!child) throw new Error(`Invalid component host at ${path}`);
      visit(child, path, new Set([...ancestors, entry.definition]));
    }
  }
  visit(root, "", new Set());
  const graph = Object.freeze({ nodes: Object.freeze(nodes) });
  for (const state of states) state.sealed = true;
  root.graph = graph;
  return graph;
}
