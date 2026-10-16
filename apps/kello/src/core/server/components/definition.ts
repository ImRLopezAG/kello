import type { ComponentHttpRoute } from "./http";
import type { SearchRouterClient } from "../../client/search-types";
import type { RouterContractClient } from "@orpc/contract";
import type { ProcedureContext, ProjectBindings } from "../rpc/procedure";
import type { Effect, Scope } from "effect";
import type { RouterContract } from "@orpc/contract";
import type { AnyRelations } from "drizzle-orm";
import type { ProjectSchema } from "../rpc/procedure";
import { applicationBase } from "../application/definition";
import { readComponentEnvironment } from "./environment";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ApplicationEnvironment, ApplicationEnvironmentOutput } from "../application/environment";
import { createEnvironmentReferences } from "../application/environment";
import type { EnvironmentReferences, EnvironmentReference } from "../application/environment";
import { createComponentHost, registerComponentDefinition, validateComponentName } from "./graph";
import type { ComponentHost } from "./graph";

type ValidServiceResult<Result> =
  Result extends Effect.Effect<infer Value, infer _Failure, infer Requirements>
    ? Value extends object
      ? [Requirements] extends [Scope.Scope]
        ? Result
        : never
      : never
    : Result extends PromiseLike<infer Value>
      ? Value extends object
        ? Result
        : never
      : Result extends object
        ? Result
        : never;

/** Services visible to a component service factory through explicitly bound component dependencies. */
export type ServiceDependencies<Components extends object> = {
  readonly [Key in keyof Components]: Components[Key] extends { readonly services: infer Services }
    ? { readonly services: Services }
    : never;
};

/** Component environment, validated options, and backend services. Services may return an object, a promise, or a scoped Effect. Mount the definition explicitly with app.use(). */
export interface ComponentConfiguration<
  Env extends ApplicationEnvironment = ApplicationEnvironment,
  Options extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  Services extends object = object,
  Dependencies extends object = Record<never, never>,
> {
  /** Default instance name; mounting may override it. Names determine persistent namespaces. */
  readonly name: string;
  /** Server-only variables validated before this component is initialized. */
  readonly env?: Env;
  /** Standard Schema for this component's own mount options. */
  readonly options?: Options;
  /** Initialize backend capabilities; dependencies expose only explicitly bound services. */
  readonly services?: (context: {
    readonly components: ServiceDependencies<Dependencies>;
    readonly env: ApplicationEnvironmentOutput<Env>;
    readonly options: Options extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<Options> : undefined;
  }) => Services & ValidServiceResult<Services>;
}

/** Structural metadata consumed by component registration. Application authors normally use the generated defineComponent facade instead of constructing descriptors. */
export interface ComponentDescriptor {
  readonly name: string;
  readonly environmentSchema?: ApplicationEnvironment;
  readonly env?: Readonly<Record<string, EnvironmentReference>>;
  readonly options?: StandardSchemaV1 | undefined;
  readonly services?: (...args: never[]) => object;
  readonly rpc?: (...args: never[]) => object;
  readonly http?: readonly ComponentHttpRoute<never>[];
}

/** A component declaration that can mount child components. Declaring it does not mount it or publish its RPCs. */
export type ComponentDefinition<Configuration extends ComponentDescriptor = ComponentDescriptor> =
  Readonly<Configuration> & ComponentHost;

/** Generated scope bindings connecting a component to its own schema, relations, contracts, and declared dependencies. */
export interface ComponentRegistration {
  readonly components: object;
  readonly schema: ProjectSchema;
  readonly relations: AnyRelations;
  readonly contract: RouterContract;
}

/** The service object produced after awaiting a promise or evaluating the component service Effect. */
export type ResolvedComponentServices<Result> =
  Result extends Effect.Effect<infer Value, infer _Error, infer _Requirements> ? Value : Awaited<Result>;

/** Infers a component factory's resolved service API; components without services expose an empty object. */
export type ComponentServices<Definition> = Definition extends {
  readonly services?: (...args: never[]) => infer Result;
}
  ? ResolvedComponentServices<Result>
  : Record<never, never>;

/** Contract-bound oRPC builder for one component scope, including typed environment and services. */
export type ComponentBase<
  Scope extends ComponentRegistration,
  Env extends ApplicationEnvironment,
  Services extends object = Record<never, never>,
> = ReturnType<
  typeof applicationBase<
    Scope["contract"],
    Scope["schema"],
    Scope["relations"],
    Env,
    Scope["components"],
    ResolvedComponentServices<Services>
  >
>;

/** Default RPC builders supplied to a scoped component when no custom builder configuration is declared. */
export type ComponentBuilders<
  Scope extends ComponentRegistration,
  Env extends ApplicationEnvironment,
  Services extends object,
> = {
  readonly os: ComponentBase<Scope, Env, Services>;
};

/** Generated authoring configuration that binds HTTP and RPC contexts to this component's schema and dependencies. */
export type ScopedComponentConfiguration<
  Scope extends ComponentRegistration,
  Env extends ApplicationEnvironment,
  Options extends StandardSchemaV1 | undefined,
  Services extends object,
  Name extends string,
  Builders extends Record<string, object>,
> = ComponentConfiguration<Env, Options, Services, Scope["components"]> & {
  readonly name: Name;
  readonly http?: readonly ComponentHttpRoute<
    ProcedureContext &
      ProjectBindings<Scope["schema"], Scope["relations"]> & {
        readonly env: ApplicationEnvironmentOutput<Env>;
        readonly options: Options extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<Options> : undefined;
        readonly services: ResolvedComponentServices<Services>;
        readonly components: Scope["components"];
        readonly internal: SearchRouterClient<
          RouterContractClient<
            Scope["contract"] extends { internal: infer Internal extends RouterContract }
              ? Internal
              : Record<never, never>
          >
        >;
      }
  >[];
  readonly rpc?: (context: { readonly os: ComponentBase<Scope, Env, Services> }) => Builders;
};

/** Registered component definition with typed environment references for mounting. Runtime handlers receive validated values instead. */
export type ScopedComponentDefinition<
  Scope extends ComponentRegistration,
  Env extends ApplicationEnvironment,
  Options extends StandardSchemaV1 | undefined,
  Services extends object,
  Name extends string,
  Builders extends Record<string, object>,
> = Readonly<Omit<ScopedComponentConfiguration<Scope, Env, Options, Services, Name, Builders>, "env">> &
  ComponentHost & {
    readonly environmentSchema: Env;
    readonly env: EnvironmentReferences<Env>;
  };

/** Used by generated setup facades to bind one scope without ambient augmentation. */
export function componentDefinitionFor<Scope extends ComponentRegistration>() {
  return function defineScopedComponent<
    const Env extends ApplicationEnvironment = Record<never, never>,
    const Options extends StandardSchemaV1 | undefined = undefined,
    const Services extends object = Record<never, never>,
    const Name extends string = string,
    const Builders extends Record<string, object> = ComponentBuilders<Scope, Env, Services>,
  >(
    configuration: ScopedComponentConfiguration<Scope, Env, Options, Services, Name, Builders>,
  ): ScopedComponentDefinition<Scope, Env, Options, Services, Name, Builders> {
    validateComponentName(configuration.name);
    // SAFETY: the default generic fixes omitted declarations to an empty record.
    const environmentSchema = Object.freeze(configuration.env ?? ({} as Env));
    const env = createEnvironmentReferences(environmentSchema);
    const definition = Object.freeze({ ...configuration, environmentSchema, env, ...createComponentHost(env) });
    registerComponentDefinition(definition);
    return definition;
  };
}

export const defineComponent = componentDefinitionFor<ComponentRegistration>();

export function createComponentRpc<
  const Scope extends ComponentRegistration,
  const Env extends ApplicationEnvironment,
  const Builders extends Record<string, object>,
  const Services extends object = Record<never, never>,
>(
  component: ComponentDefinition & {
    readonly environmentSchema: Env;
    readonly rpc?: (context: { readonly os: ComponentBase<Scope, Env, Services> }) => Builders;
  },
  scope: Pick<Scope, "schema" | "relations" | "contract">,
) {
  const os = applicationBase<
    Scope["contract"],
    Scope["schema"],
    Scope["relations"],
    Env,
    Scope["components"],
    ResolvedComponentServices<Services>
  >(scope.contract, scope.schema, scope.relations, () => readComponentEnvironment(component));
  // SAFETY: omitted rpc is the generated default os builder; authored callbacks
  // return Builders. Both paths use this scope's native contract and middleware.
  return (component.rpc ? component.rpc({ os }) : { os }) as Builders;
}
