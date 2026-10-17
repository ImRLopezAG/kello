import { AsyncLocalStorage } from "node:async_hooks";
import * as v from "valibot";
import { implement } from "@orpc/server";
import type { Middleware, RouterImplementerWithMiddlewares } from "@orpc/server";
import type { RouterContractClient, RouterContract } from "@orpc/contract";
import type { SearchRouterClient } from "../../client/search-types";
import type { AnyRelations } from "drizzle-orm";
import type { ProjectRegistration } from "../../contract";
import { createProjectContext, rpcErrorBoundary } from "../rpc/procedure";
import type { ProcedureContext, ProjectSchema } from "../rpc/procedure";
import { createDatabaseMiddleware } from "../rpc/database";
import type { ApplicationEnvironment, ApplicationEnvironmentOutput } from "./environment";
import { parseApplicationEnvironment, createEnvironmentReferences, environmentAccess } from "./environment";
import type { EnvironmentReferences } from "./environment";
import { createComponentHost, sealComponentGraph } from "../components/graph";
import { deferEnvironmentAccess, prepareComponentEnvironments } from "../components/environment";
import type { ComponentHost } from "../components/graph";
import type { LiveQueryTarget } from "../realtime/procedure";
import type { TrustedLoginResolver } from "../auth/login";

/** The Realtime signing secret is fetched by deployment from the selected branch
 * and injected through a managed variable; applications never declare or copy it. */
type ApplicationRealtime = LiveQueryTarget;
type ApplicationLiveQueries<Env extends ApplicationEnvironment> = (context: {
  readonly env: ApplicationEnvironmentOutput<Env>;
  readonly realtime: ApplicationRealtime;
}) => LiveQueryTarget & { readonly resolveLogin: TrustedLoginResolver };

interface LiveQueryDeclaration<Env extends ApplicationEnvironment> {
  liveQueries?: ApplicationLiveQueries<Env>;
}

interface PreparedLiveQueries {
  liveQueries?: LiveQueryTarget & { readonly resolveLogin: TrustedLoginResolver };
}

type RegisteredComponents = ProjectRegistration extends { components: infer Components extends object }
  ? Components
  : Record<never, never>;

type RegisteredContract = ProjectRegistration extends { contract: infer Contract extends RouterContract }
  ? Contract
  : Record<never, never>;
type RegisteredSchema = ProjectRegistration extends { schema: infer Schema extends ProjectSchema }
  ? Schema
  : ProjectSchema;
type RegisteredRelations = ProjectRegistration extends { relations: infer Relations extends AnyRelations }
  ? Relations
  : AnyRelations;

interface EnvironmentScope {
  readonly application: object;
  readonly env: object;
}
const environment = new AsyncLocalStorage<EnvironmentScope>();
const applications = new WeakSet<object>();

export function isApplicationDefinition(value: unknown): value is ApplicationEnvironmentDefinition {
  return v.is(v.object({}), value) && applications.has(value);
}

type InjectedContext<Binding> =
  Binding extends Middleware<infer _Initial, infer Injected, infer _Input, infer _Output, infer _Errors>
    ? Injected
    : never;
type SchemaContext<Schema extends ProjectSchema, Relations extends AnyRelations> = InjectedContext<
  ReturnType<typeof createProjectContext<Schema, Relations>>["middleware"]
>;
type DatabaseContext<Schema extends ProjectSchema, Relations extends AnyRelations> = InjectedContext<
  ReturnType<typeof createDatabaseMiddleware<Relations, Schema>>
>;
type ApplicationContext<
  Schema extends ProjectSchema,
  Relations extends AnyRelations,
  Env extends ApplicationEnvironment,
> = Omit<SchemaContext<Schema, Relations>, keyof DatabaseContext<Schema, Relations>> &
  DatabaseContext<Schema, Relations> & {
    readonly env: ApplicationEnvironmentOutput<Env>;
  };
export function applicationBase<
  Contract extends RouterContract,
  Schema extends ProjectSchema,
  Relations extends AnyRelations,
  Env extends ApplicationEnvironment,
  Components extends object = Record<never, never>,
  Services = Record<never, never>,
>(contract: Contract, schema: Schema, relations: Relations, readEnv: () => ApplicationEnvironmentOutput<Env>) {
  const bindings = createProjectContext(schema, relations);
  const builder = implement(contract)
    .$context<ProcedureContext>()
    .use(rpcErrorBoundary)
    .use(bindings.middleware)
    .use(createDatabaseMiddleware(relations, "automatic", schema))
    .use(({ next }) => next({ context: { env: readEnv() } }));
  // SAFETY: native .use() widens a generic router's conditional type inside this
  // function. The original contract and the middleware-derived injected context
  // above are unchanged; preserve them at the project factory boundary.
  return builder as RouterImplementerWithMiddlewares<
    Contract,
    ProcedureContext,
    ApplicationContext<Schema, Relations, Env> & {
      readonly components: Components;
      readonly services: Services;
      readonly internal: SearchRouterClient<
        RouterContractClient<
          Contract extends { internal: infer Internal extends RouterContract } ? Internal : Record<never, never>
        >
      >;
    }
  >;
}

type ApplicationBase<Env extends ApplicationEnvironment> = ReturnType<
  typeof applicationBase<RegisteredContract, RegisteredSchema, RegisteredRelations, Env, RegisteredComponents>
>;

/** Application declaration with environment references, native RPC builders, and explicit component mounts. Runtime handlers receive parsed environment values through context. */
export interface ApplicationDefinition<
  Env extends ApplicationEnvironment,
  Builders extends Record<string, object>,
> extends ComponentHost {
  readonly env: EnvironmentReferences<Env>;
  readonly environmentSchema: Env;
  readonly liveQueries?: ApplicationLiveQueries<Env>;
  readonly rpc: (context: { readonly os: ApplicationBase<Env> }) => Builders;
}

export function defineApplication<
  const Env extends ApplicationEnvironment,
  const Builders extends Record<string, object>,
>(options: {
  readonly env: Env;
  readonly liveQueries?: ApplicationLiveQueries<Env>;
  readonly rpc: (context: { readonly os: ApplicationBase<Env> }) => Builders;
}): ApplicationDefinition<Env, Builders>;
export function defineApplication<const Builders extends Record<string, object>>(options: {
  readonly liveQueries?: ApplicationLiveQueries<Record<never, never>>;
  readonly rpc: (context: { readonly os: ApplicationBase<Record<never, never>> }) => Builders;
}): ApplicationDefinition<Record<never, never>, Builders>;
export function defineApplication<
  const Env extends ApplicationEnvironment,
  const Builders extends Record<string, object>,
>(options: {
  readonly env?: Env;
  readonly liveQueries?: ApplicationLiveQueries<Env>;
  readonly rpc: (context: { readonly os: ApplicationBase<Env> }) => Builders;
}): ApplicationDefinition<Env, Builders> {
  // SAFETY: the public no-environment overload fixes Env to an empty record.
  const environmentSchema = Object.freeze(options.env ?? ({} as Env));
  const env = createEnvironmentReferences(environmentSchema);
  const live: LiveQueryDeclaration<Env> = {};
  if (options.liveQueries) live.liveQueries = options.liveQueries;
  const app = Object.freeze({
    env,
    environmentSchema,
    rpc: options.rpc,
    ...live,
    ...createComponentHost(env),
  });
  applications.add(app);
  return app;
}

/** Generation constructs builders with schema bindings, without resolving secrets. */
export function createApplicationRpc<Env extends ApplicationEnvironment, Builders extends Record<string, object>>(
  app: ApplicationDefinition<Env, Builders>,
  project: {
    readonly contract: RegisteredContract;
    readonly schema: RegisteredSchema;
    readonly relations: RegisteredRelations;
  },
): Builders {
  if (!applications.has(app)) throw new Error("Expected defineApplication's result");
  return app.rpc({
    os: applicationBase<RegisteredContract, RegisteredSchema, RegisteredRelations, Env, RegisteredComponents>(
      project.contract,
      project.schema,
      project.relations,
      () => readApplicationEnvironment(app),
    ),
  });
}

export interface ApplicationEnvironmentDefinition<
  Env extends ApplicationEnvironment = ApplicationEnvironment,
> extends ComponentHost {
  readonly environmentSchema: Env;
  liveQueries?(context: {
    readonly env: ApplicationEnvironmentOutput<Env>;
    readonly realtime: ApplicationRealtime;
  }): LiveQueryTarget & {
    readonly resolveLogin: TrustedLoginResolver;
  };
  readonly env: EnvironmentReferences<Env>;
}

export function readApplicationEnvironment<Env extends ApplicationEnvironment>(
  app: ApplicationEnvironmentDefinition<Env>,
) {
  const current = environment.getStore();
  if (!current || current.application !== app) throw new Error("Application environment is unavailable");
  // SAFETY: prepareApplicationEnvironment validated this exact application's declaration.
  return current.env as ApplicationEnvironmentOutput<Env>;
}

export function createApplicationEnvironmentAccess<Env extends ApplicationEnvironment>(
  app: ApplicationEnvironmentDefinition<Env> | (() => ApplicationEnvironmentDefinition<Env>),
): ApplicationEnvironmentOutput<Env> {
  if (v.is(v.function(), app)) return deferEnvironmentAccess(() => createApplicationEnvironmentAccess(app()));
  return environmentAccess(app.environmentSchema, () => readApplicationEnvironment(app));
}

/** Validate all mounted scopes before serving, without acquiring SDK services. */
export async function prepareApplicationEnvironment<Env extends ApplicationEnvironment>(
  app: ApplicationEnvironmentDefinition<Env>,
  source: Readonly<Record<string, string | undefined>>,
  target?: Pick<LiveQueryTarget, "database" | "deployment">,
) {
  if (!applications.has(app)) throw new Error("Expected defineApplication's result");
  const graph = sealComponentGraph(app);
  const env = await parseApplicationEnvironment(app.environmentSchema, source);
  const components = await prepareComponentEnvironments(graph, env, source);
  // Without the deployment-managed secret, .live() issuance stays unconfigured and fails closed.
  const secret = source.LOOM_REALTIME_SECRET;
  if (secret && app.liveQueries && !target)
    throw new Error("Live queries require the runtime database and deployment binding");
  const liveQueries =
    secret && target ? app.liveQueries?.({ env, realtime: Object.freeze({ ...target, secret }) }) : undefined;
  const live: PreparedLiveQueries = {};
  if (liveQueries) live.liveQueries = Object.freeze({ ...liveQueries });
  return Object.freeze({
    ...live,
    serviceFactories: components.serviceFactories,
    http: components.http,
    run: <Result>(work: () => Result): Result => environment.run({ application: app, env }, work),
    runComponent: <Result>(path: string, work: () => Result): Result =>
      environment.exit(() => components.runComponent(path, work)),
  });
}
