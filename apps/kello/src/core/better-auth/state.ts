import { AsyncLocalStorage } from "node:async_hooks";
import type { BetterAuthConfiguration, NativeAuth } from "./definition";
import type { ApplicationEnvironment } from "../server/application/environment";
import type { ComponentDefinition } from "../server/components/definition";

interface BetterAuthRegistration {
  readonly create: BetterAuthConfiguration<ApplicationEnvironment, NativeAuth>["create"];
  readonly initialize: typeof import("./runtime").initializeBetterAuth;
  readonly resolve: typeof import("./resolve").resolveBetterAuthSchema;
}

const registrations = new WeakMap<object, BetterAuthRegistration>();
const instances = new AsyncLocalStorage<ReadonlyMap<object, NativeAuth>>();

/** Only the explicit Better Auth entry point registers its optional runtime. */
export function registerBetterAuth(
  component: Pick<ComponentDefinition, "name">,
  registration: BetterAuthRegistration,
): void {
  registrations.set(component, registration);
}

export function getBetterAuthRegistration(component: Pick<ComponentDefinition, "name">) {
  return registrations.get(component);
}

export function getBetterAuthInstance(component: Pick<ComponentDefinition, "name">) {
  return instances.getStore()?.get(component);
}

/** Scope instances to one runtime generation, never to a process-global current app. */
export function withBetterAuthInstances<T>(bindings: ReadonlyMap<object, NativeAuth>, run: () => T): T {
  return instances.run(bindings, run);
}
