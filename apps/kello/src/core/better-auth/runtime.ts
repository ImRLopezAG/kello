import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ApplicationEnvironmentDefinition, prepareApplicationEnvironment } from "../server/application/definition";
import { sealComponentGraph } from "../server/components/graph";
import { readComponentEnvironment } from "../server/components/environment";
import { getBetterAuthRegistration, withBetterAuthInstances } from "./state";
import { createBetterAuthDatabase } from "./database";
import { validateBetterAuthInstance } from "./resolve";
import type { AuthHttpMount } from "../adapters/neon/auth-http";
import type { AuthConfigInput } from "../server/auth/config";
import { validateBetterAuthTrust } from "./trust";

export interface RuntimeAuthScope {
  readonly mountPath: string;
  readonly namespace: string;
  readonly fingerprint: string;
}

/** Initialize once per mount and bind native services to this generation only. No DDL. */
export async function initializeBetterAuth(options: {
  readonly definition: ApplicationEnvironmentDefinition;
  readonly application: Awaited<ReturnType<typeof prepareApplicationEnvironment>>;
  readonly scopes: readonly RuntimeAuthScope[];
  readonly database: NodePgDatabase;
  readonly activate: (signal: AbortSignal) => Promise<void>;
  readonly trust?: AuthConfigInput;
}) {
  const factories = { ...options.application.serviceFactories };
  const mounts: AuthHttpMount[] = [];
  const remaining = new Set(options.scopes.map((scope) => scope.mountPath));
  if (remaining.size !== options.scopes.length) throw new Error("Duplicate planned auth scope");
  for (const node of sealComponentGraph(options.definition).nodes) {
    const create = getBetterAuthRegistration(node.definition)?.create;
    if (!create) continue;
    const scope = options.scopes.find((entry) => entry.mountPath === node.path);
    if (!scope) throw new Error(`Missing planned auth fingerprint: ${node.path}`);
    remaining.delete(node.path);
    const database = createBetterAuthDatabase(options.database, scope.namespace);
    const auth = await options.application.runComponent(node.path, async () => {
      const instance = create({ env: readComponentEnvironment(node.definition), database });
      await validateBetterAuthInstance(instance, database, scope.namespace, scope.fingerprint);
      validateBetterAuthTrust(instance, options.trust ?? {});
      return instance;
    });
    const factory = factories[node.path];
    if (!factory) throw new Error(`Missing native auth service: ${node.path}`);
    factories[node.path] = (dependencies) =>
      withBetterAuthInstances(new Map([[node.definition, auth]]), () => factory(dependencies));
    mounts.push({
      prefix: auth.options.basePath ?? "/api/auth",
      handle: async (request) => {
        await options.activate(request.signal);
        return options.application.runComponent(node.path, () => auth.handler(request));
      },
    });
  }
  if (remaining.size) throw new Error("Planned auth scope has no mounted definition");
  return { application: { ...options.application, serviceFactories: Object.freeze(factories) }, mounts };
}
