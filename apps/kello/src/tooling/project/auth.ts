import { prepareApplicationEnvironment, readComponentEnvironment } from "kello/server";
import type { ApplicationEnvironmentDefinition, ComponentNode } from "kello/server";
import { getBetterAuthRegistration } from "../../core/better-auth/state";
import { componentNamespace } from "./component-namespace";

/** Optional peers load only when the application explicitly mounts custom auth. */
export async function resolveProjectAuth(
  application: ApplicationEnvironmentDefinition,
  nodes: readonly ComponentNode[],
) {
  const mounted = nodes.flatMap((node) => {
    const registration = getBetterAuthRegistration(node.definition);
    return registration ? [{ node, registration }] : [];
  });
  if (!mounted.length) return [];
  const environment = await prepareApplicationEnvironment(application, process.env);
  return Promise.all(
    mounted.map(async ({ node, registration }) => {
      const namespace = componentNamespace(node.path);
      const schema = await environment.runComponent(node.path, () =>
        registration.resolve(
          (database) => registration.create({ env: readComponentEnvironment(node.definition), database }),
          namespace,
        ),
      );
      return { mountPath: node.path, namespace, schema, fingerprint: schema.fingerprint };
    }),
  );
}
