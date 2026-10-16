import { mkdir, readFile } from "node:fs/promises";
import * as v from "valibot";
import type { NeonApi } from "@neon/config-runtime/v1";
import { withProjectConfigurationLock } from "./environment-file";
import { writeReceiptFile } from "../deploy/receipt-file";
import { createKelloNeonApi } from "../neon/api";
import { resolveProjectPath } from "./paths";
import type { KelloConfig } from "./define-config";

const id = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/));
const branchName = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const publicUrl = v.pipe(
  v.string(),
  v.url(),
  v.check((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }, "Public service URLs must use HTTPS without credentials, query parameters, or fragments"),
);
export const publicProjectValidator = v.strictObject({
  serviceUrl: v.optional(publicUrl),
  authUrl: v.optional(publicUrl),
  dataApiUrl: v.optional(publicUrl),
});
export type PublicProjectConfiguration = v.InferOutput<typeof publicProjectValidator>;
export const resolvedProjectValidator = v.strictObject({
  format: v.literal(1),
  projectId: id,
  branchId: id,
  branchName,
  protected: v.boolean(),
  isDefault: v.boolean(),
  databaseName: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,62}$/)),
  migrationRole: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,62}$/)),
  public: publicProjectValidator,
});
export type ResolvedNeonProject = v.InferOutput<typeof resolvedProjectValidator>;
const linkValidator = v.object({ projectId: v.optional(id), branch: v.optional(branchName), branchId: v.optional(id) });
const selectionValidator = v.strictObject({
  projectId: v.optional(id),
  branch: v.optional(branchName),
  databaseName: v.optional(v.string()),
  serviceSlug: v.optional(v.string()),
});
export type NeonProjectSelection = v.InferInput<typeof selectionValidator>;
export type DiscoveryProvider = Pick<
  NeonApi,
  "getProject" | "listBranches" | "listBranchDatabases" | "getNeonAuth" | "getNeonDataApi" | "listBranchFunctions"
>;

export class ProjectResolutionError extends Error {
  constructor(
    readonly code:
      | "PROJECT_CONFLICT"
      | "PROJECT_REQUIRED"
      | "BRANCH_AMBIGUOUS"
      | "DATABASE_AMBIGUOUS"
      | "SERVICE_AMBIGUOUS"
      | "PROJECT_STATE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ProjectResolutionError";
  }
}
async function optionalJson<TSchema extends v.GenericSchema>(
  root: string,
  path: string,
  schema: TSchema,
): Promise<v.InferOutput<TSchema> | undefined> {
  try {
    return v.parse(schema, JSON.parse(await readFile(await resolveProjectPath(root, path), "utf8")));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw new ProjectResolutionError(
      "PROJECT_STATE_INVALID",
      `Could not read ${path}; repair the file before continuing.`,
    );
  }
}
export async function readResolvedProject(root: string): Promise<ResolvedNeonProject | undefined> {
  return optionalJson(root, ".loom/project.json", resolvedProjectValidator);
}
/** Read only. A returned invocation URL is discovery evidence, not a health check. */
export async function resolveNeonProject(
  root: string,
  config: KelloConfig,
  input: NeonProjectSelection = {},
  provider: DiscoveryProvider = createKelloNeonApi(),
): Promise<ResolvedNeonProject> {
  const selection = v.parse(selectionValidator, input);
  const link = (await optionalJson(root, ".neon", linkValidator)) ?? {};
  const saved = await readResolvedProject(root);
  const projectIds = [
    selection.projectId,
    config.projectId,
    config.provider?.projectId,
    process.env.NEON_PROJECT_ID,
    link.projectId,
    saved?.projectId,
  ].filter((value) => value !== undefined);
  if (new Set(projectIds).size > 1)
    throw new ProjectResolutionError(
      "PROJECT_CONFLICT",
      "Project identities disagree across flags, configuration, environment, or saved link. Relink explicitly before continuing.",
    );
  const projectId = projectIds[0];
  if (!projectId)
    throw new ProjectResolutionError("PROJECT_REQUIRED", "Select a Neon project with kello link or NEON_PROJECT_ID.");
  v.parse(id, projectId);
  const [project, branches] = await Promise.all([provider.getProject(projectId), provider.listBranches(projectId)]);
  if (project.id !== projectId || project.pgVersion !== 18)
    throw new ProjectResolutionError("PROJECT_STATE_INVALID", "Kello requires the selected PostgreSQL 18 project.");
  const selector =
    selection.branch ??
    config.branchId ??
    process.env.NEON_BRANCH_ID ??
    link.branch ??
    link.branchId ??
    saved?.branchId;
  const candidates = selector
    ? branches.filter((branch) => branch.id === selector || branch.name === selector)
    : branches.filter((branch) => branch.isDefault);
  const branch = candidates[0];
  if (!branch || candidates.length !== 1)
    throw new ProjectResolutionError("BRANCH_AMBIGUOUS", "Select one unambiguous Neon branch.");
  const databases = await provider.listBranchDatabases(projectId, branch.id);
  const databaseName =
    selection.databaseName ??
    config.deployment?.databaseName ??
    config.development?.databaseName ??
    (saved?.branchId === branch.id ? saved.databaseName : undefined);
  const matches = databaseName ? databases.filter((database) => database.name === databaseName) : databases;
  const database = matches[0];
  if (!database || matches.length !== 1 || database.branchId !== branch.id)
    throw new ProjectResolutionError(
      "DATABASE_AMBIGUOUS",
      "Select a database explicitly when the branch has multiple databases or the saved database is absent.",
    );
  const [auth, dataApi, functions] = await Promise.all([
    provider.getNeonAuth(projectId, branch.id),
    provider.getNeonDataApi(projectId, branch.id, database.name),
    provider.listBranchFunctions(projectId, branch.id),
  ]);
  const serviceSlug = selection.serviceSlug ?? config.deployment?.slugs?.service;
  const savedUrl = saved?.branchId === branch.id ? saved.public.serviceUrl : undefined;
  const services = serviceSlug
    ? functions.filter((entry) => entry.slug === serviceSlug)
    : savedUrl
      ? functions.filter((entry) => entry.invocationUrl === savedUrl)
      : [];
  if ((serviceSlug || savedUrl) && services.length !== 1)
    throw new ProjectResolutionError(
      "SERVICE_AMBIGUOUS",
      "The selected Kello service function is absent or ambiguous.",
    );
  const publicConfiguration: PublicProjectConfiguration = {};
  if (services[0]) publicConfiguration.serviceUrl = services[0].invocationUrl;
  if (auth?.baseUrl) publicConfiguration.authUrl = auth.baseUrl;
  if (dataApi) publicConfiguration.dataApiUrl = dataApi.url;
  return v.parse(resolvedProjectValidator, {
    format: 1,
    projectId,
    branchId: branch.id,
    branchName: branch.name,
    protected: branch.protected,
    isDefault: branch.isDefault,
    databaseName: database.name,
    migrationRole: database.ownerName,
    public: publicConfiguration,
  });
}

/** Browser-facing output is assembled field by field, never by copying provider responses. */
export async function readPublicProjectConfiguration(
  root: string,
  config: KelloConfig,
): Promise<PublicProjectConfiguration> {
  const saved = await readResolvedProject(root);
  const link = (await optionalJson(root, ".neon", linkValidator)) ?? {};
  const identities = [
    config.projectId,
    config.provider?.projectId,
    process.env.NEON_PROJECT_ID,
    link.projectId,
    saved?.projectId,
  ].filter((value) => value !== undefined);
  if (new Set(identities).size > 1)
    throw new ProjectResolutionError(
      "PROJECT_CONFLICT",
      "Saved discovery belongs to a different Neon project. Relink before generating client configuration.",
    );
  const selectedBranch = config.branchId ?? process.env.NEON_BRANCH_ID ?? link.branch ?? link.branchId;
  if (saved && selectedBranch && selectedBranch !== saved.branchId && selectedBranch !== saved.branchName)
    throw new ProjectResolutionError(
      "PROJECT_STATE_INVALID",
      "The Neon branch changed. Refresh discovery before generating public client configuration.",
    );
  const serviceUrl = process.env.LOOM_URL ?? saved?.public.serviceUrl;
  const authUrl = process.env.NEON_AUTH_URL ?? saved?.public.authUrl;
  const dataApiUrl = saved?.public.dataApiUrl;
  const result: PublicProjectConfiguration = {};
  if (serviceUrl) result.serviceUrl = serviceUrl;
  if (authUrl) result.authUrl = authUrl;
  if (dataApiUrl) result.dataApiUrl = dataApiUrl;
  return v.parse(publicProjectValidator, result);
}

export async function saveResolvedProject(root: string, value: ResolvedNeonProject): Promise<void> {
  const parsed = v.parse(resolvedProjectValidator, value);
  await withProjectConfigurationLock(root, async () => {
    const prior = await readResolvedProject(root);
    if (prior && prior.projectId !== parsed.projectId)
      throw new ProjectResolutionError(
        "PROJECT_CONFLICT",
        "Refusing to replace discovery for another project without an explicit relink.",
      );
    const directory = await resolveProjectPath(root, ".loom");
    await mkdir(directory, { recursive: true });
    await writeReceiptFile(directory, "project.json", JSON.stringify(parsed, null, 2) + "\n");
  });
}
