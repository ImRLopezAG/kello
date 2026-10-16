import type { BetterAuthOptions } from "better-auth";
import type { DBAdapterInstance } from "@better-auth/core/db/adapter";
import type { ApplicationEnvironment, ApplicationEnvironmentOutput } from "../server/application/environment";
import { defineComponent } from "../server/components/definition";
import { getBetterAuthInstance, registerBetterAuth } from "./state";
import { initializeBetterAuth } from "./runtime";
import { resolveBetterAuthSchema } from "./resolve";

/** Native Better Auth server surface required for Kello mounting and effective schema discovery. Preserve the concrete instance type to retain plugin API inference. */
export interface NativeAuth {
  readonly handler: (request: Request) => Promise<Response>;
  readonly options: BetterAuthOptions;
  readonly $context: Promise<{ readonly options: BetterAuthOptions }>;
}

/** Self-hosted Better Auth component factory. Pass Kello's database adapter to betterAuth and keep configuration deterministic: generation evaluates it without a live database. */
export interface BetterAuthConfiguration<Env extends ApplicationEnvironment, Auth extends NativeAuth> {
  readonly name: string;
  readonly env: Env;
  readonly create: (context: {
    readonly env: ApplicationEnvironmentOutput<Env>;
    readonly database: DBAdapterInstance;
  }) => Auth;
}

/** Typed native auth instance available as a backend component service, including the installed plugins' server APIs. */
export interface BetterAuthServices<Auth extends NativeAuth> {
  readonly auth: Auth;
}

/** The native instance remains typed; mounting is explicit through app.use(). */
export function defineBetterAuth<const Env extends ApplicationEnvironment, Auth extends NativeAuth>(
  configuration: BetterAuthConfiguration<Env, Auth>,
) {
  const component = defineComponent({
    name: configuration.name,
    env: configuration.env,
    services: (): BetterAuthServices<Auth> => {
      const auth = getBetterAuthInstance(component);
      if (!auth) throw new Error("Better Auth is unavailable outside its initialized Kello runtime");
      // SAFETY: the runtime binds the instance produced by this exact component's factory.
      return { auth: auth as Auth };
    },
  });
  // SAFETY: environment validation is bound to the component declaration before invocation.
  registerBetterAuth(component, {
    create: configuration.create as BetterAuthConfiguration<ApplicationEnvironment, NativeAuth>["create"],
    initialize: initializeBetterAuth,
    resolve: resolveBetterAuthSchema,
  });
  return component;
}
