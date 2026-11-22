/**
 * Pure lifecycle rules for disposable Neon acceptance branches. No network access: callers fetch
 * provider state and pass it in, so the rules stay unit-testable and the destructive paths stay
 * behind strict name validation.
 */

export const ACCEPTANCE_BRANCH_PREFIX = "kello-acceptance-";
/** Longest lifetime an acceptance branch may have; leftovers must expire on their own. */
export const MAX_ACCEPTANCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Lifetime given to branches the acceptance suites create themselves. */
export const DEFAULT_ACCEPTANCE_TTL_MS = 24 * 60 * 60 * 1000;

const NAMESPACE = /^accept_[a-f0-9]{32}$/;
const METADATA_NAMESPACE = /^kello_accept_[a-f0-9]{32}$/;
const RUNTIME_ROLE = /^runtime_[a-f0-9]{32}$/;
const FUNCTION_SLUG = /^[a-z0-9]{1,20}$/;

export interface AcceptanceBranch {
  readonly name: string;
  readonly protected?: boolean | undefined;
  readonly default?: boolean | undefined;
  readonly expires_at?: string | null | undefined;
}

/** ISO expiry for a branch created now; always within {@link MAX_ACCEPTANCE_TTL_MS}. */
export function acceptanceExpiry(now = Date.now(), ttlMs = DEFAULT_ACCEPTANCE_TTL_MS): string {
  if (!(ttlMs > 0 && ttlMs <= MAX_ACCEPTANCE_TTL_MS)) throw new Error("Acceptance branch TTL is out of range");
  return new Date(now + ttlMs).toISOString();
}

/** Throws unless the branch is an unprotected, non-default acceptance branch (expiry not checked). */
export function assertAcceptanceBranch(branch: AcceptanceBranch): void {
  if (!branch.name.startsWith(ACCEPTANCE_BRANCH_PREFIX) || branch.protected || branch.default)
    throw new Error(`Use an unprotected, non-default ${ACCEPTANCE_BRANCH_PREFIX}* branch`);
}

/** Throws unless the branch is a disposable, unprotected acceptance branch that expires within the cap. */
export function assertDisposableBranch(branch: AcceptanceBranch, now = Date.now()): void {
  assertAcceptanceBranch(branch);
  if (!branch.expires_at)
    throw new Error("Acceptance branch has no expiry; run `neon branches set-expiration <id> --expires-at <iso>`");
  const expires = Date.parse(branch.expires_at);
  if (Number.isNaN(expires)) throw new Error("Acceptance branch expiry is not a valid timestamp");
  if (expires <= now) throw new Error("Acceptance branch has already expired");
  if (expires - now > MAX_ACCEPTANCE_TTL_MS) throw new Error("Acceptance branch expires more than 7 days from now");
}

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export interface TeardownPlan {
  readonly functions: readonly string[];
  readonly schemas: readonly string[];
  readonly roles: readonly string[];
}

/**
 * Validates every name before it can reach a destructive statement. Invalid names throw rather
 * than being skipped so a malformed receipt cannot silently widen or narrow the teardown.
 */
export function planTeardown(input: {
  functions?: readonly string[];
  schemas?: readonly string[];
  roles?: readonly string[];
}): TeardownPlan {
  const functions = [...new Set(input.functions ?? [])];
  const schemas = [...new Set(input.schemas ?? [])];
  const roles = [...new Set(input.roles ?? [])];
  for (const slug of functions) if (!FUNCTION_SLUG.test(slug)) throw new Error("Refusing invalid function slug");
  for (const schema of schemas)
    if (!NAMESPACE.test(schema) && !METADATA_NAMESPACE.test(schema)) throw new Error("Refusing non-acceptance schema");
  for (const role of roles) if (!RUNTIME_ROLE.test(role)) throw new Error("Refusing non-runtime role");
  return { functions, schemas, roles };
}

/** The application and metadata schemas the tasks fixture derives from its runtime role. */
export function acceptanceSchemasForRole(runtimeRole: string): string[] {
  if (!RUNTIME_ROLE.test(runtimeRole)) throw new Error("Refusing non-runtime role");
  const namespace = `accept_${runtimeRole.slice("runtime_".length)}`;
  return [namespace, `kello_${namespace}`];
}

/** Ordered SQL for the database half of a plan. Functions must already be deleted. */
export function teardownStatements(plan: TeardownPlan): string[] {
  const validated = planTeardown(plan);
  return [
    ...validated.schemas.map((schema) => `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`),
    ...validated.roles.flatMap((role) => [
      `REASSIGN OWNED BY ${quoteIdentifier(role)} TO CURRENT_USER`,
      `DROP OWNED BY ${quoteIdentifier(role)}`,
      `DROP ROLE ${quoteIdentifier(role)}`,
    ]),
  ];
}

/** Filters provider listings down to leftovers this tooling is allowed to remove. */
export function selectLeftovers(input: {
  schemas: readonly string[];
  roles: readonly string[];
  functions: readonly string[];
  keepFunctions?: readonly string[];
}): TeardownPlan {
  const keep = new Set(input.keepFunctions ?? []);
  return planTeardown({
    schemas: input.schemas.filter((name) => NAMESPACE.test(name) || METADATA_NAMESPACE.test(name)),
    roles: input.roles.filter((name) => RUNTIME_ROLE.test(name)),
    functions: input.functions.filter((slug) => FUNCTION_SLUG.test(slug) && !keep.has(slug)),
  });
}

/** Strips anything that looks like a credential before an error reaches CI output. */
export function redact(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgresql://[redacted]")
    .replace(/(password|token|secret|apikey|api_key)=\S+/gi, "$1=[redacted]")
    .replace(/\bnapi_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[redacted]");
}
