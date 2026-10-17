/** Provider defaults must not be replaced by application variables or retained deployment overrides. */
export const neonInjectedVariables = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "NEON_BRANCH",
  "NEON_AUTH_BASE_URL",
  "NEON_AUTH_JWKS_URL",
  "NEON_DATA_API_URL",
  "NEON_AI_GATEWAY_TOKEN",
  "NEON_AI_GATEWAY_BASE_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ENDPOINT_URL_S3",
  "AWS_REGION",
] as const;

const injected = new Set<string>(neonInjectedVariables);
const managed = new Set(["LOOM_ACTIVATION_TOKEN", "LOOM_SEARCH_CURSOR_KEY", "LOOM_REALTIME_SECRET"]);

/** Provider-injected values are validated at runtime, never copied from the deployer's environment. */
export function applicationEnvironmentSources(declaration: ApplicationEnvironment = {}) {
  if (Object.keys(declaration).some((name) => managed.has(name)))
    throw new Error("Application declares a managed secret");
  return Object.fromEntries(
    Object.keys(declaration)
      .filter((name) => !injected.has(name))
      .map((name) => [name, name]),
  );
}

export async function resolveReleaseEnvironment(
  sources: Readonly<Record<string, string>>,
  declaration: ApplicationEnvironment | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  components: readonly ApplicationEnvironment[] = [],
): Promise<Readonly<Record<string, string>>> {
  if (
    [...Object.keys(sources), ...[declaration ?? {}, ...components].flatMap(Object.keys)].some((name) =>
      managed.has(name),
    )
  )
    throw new Error("Release environment overrides a managed secret");
  const declarations = [declaration ?? {}, ...components].map((schema) =>
    Object.fromEntries(Object.entries(schema).filter(([name]) => !injected.has(name))),
  );
  const declared = new Set(declarations.flatMap((schema) => Object.keys(schema)));
  const variables = new Map<string, string>();
  for (const [name, source] of Object.entries(sources)) {
    const value = Object.hasOwn(environment, source) ? environment[source] : undefined;
    if (!declared.has(name) && !value) throw new Error("Missing release environment value");
    // Neon interprets an empty value as deletion. Explicit deletion also removes
    // an optional value retained by a previous deployment's merged environment.
    variables.set(name, value ?? "");
  }
  const values = Object.fromEntries(variables);
  for (const application of declarations)
    await parseApplicationEnvironment(
      application,
      Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value || undefined])),
    );
  return values;
}
import { parseApplicationEnvironment } from "kello/server";
import type { ApplicationEnvironment } from "kello/server";

/** Bound values are supplied through the parent's declaration, never copied under a child alias. */
export function componentEnvironmentDeclarations(nodes: ComponentGraph["nodes"]) {
  return nodes.map((node) =>
    Object.fromEntries(
      Object.entries(node.definition.environmentSchema ?? {}).filter(([key]) => !Object.hasOwn(node.env, key)),
    ),
  );
}
import type { ComponentGraph } from "kello/server";
import type { RealtimeProvider } from "../../neon/api";

/** Live deployments re-read Realtime on the selected branch at release time and
 * carry the SDK secret only in managed function variables. Ordinary HTTP apps skip this. */
export async function resolveRealtimeEnvironment(
  live: boolean,
  target: { readonly projectId: string; readonly branchId: string },
  provider: RealtimeProvider,
): Promise<{ readonly LOOM_REALTIME_SECRET?: string }> {
  if (!live) return {};
  const state = await provider.get(target.projectId, target.branchId);
  if (!state.enabled || state.pending || !state.invocationUrl)
    throw new Error("Realtime is not ready on the selected branch. Run `kello realtime enable` first.");
  const secret = await provider.secret(target.projectId, target.branchId);
  if (!secret) throw new Error("Neon Realtime secret is unavailable");
  return { LOOM_REALTIME_SECRET: secret };
}
