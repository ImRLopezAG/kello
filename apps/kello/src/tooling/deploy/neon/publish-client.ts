import { publishProjectConfiguration, assertGeneratedVersion } from "../../codegen/generate";
import { writeManagedPublicEnvironment } from "../../config/environment-file";
import { readResolvedProject, resolveNeonProject, saveResolvedProject } from "../../config/resolve";
import type { DiscoveryProvider } from "../../config/resolve";
import { loadProjectConfig } from "../../project/load";

/** Publish public coordinates only for the linked branch; explicit alternate targets do not relink the workspace. */
export async function publishDeployedClient(
  root: string,
  release: { projectId: string; branchId: string; version: string; serviceSlug: string },
  provider?: DiscoveryProvider,
) {
  const saved = await readResolvedProject(root);
  if (!saved || saved.projectId !== release.projectId || saved.branchId !== release.branchId) return;
  await assertGeneratedVersion(root, release.version);
  const { config } = await loadProjectConfig(root);
  const resolved = await resolveNeonProject(
    root,
    config,
    {
      projectId: release.projectId,
      branch: release.branchId,
      serviceSlug: release.serviceSlug,
    },
    provider,
  );
  await saveResolvedProject(root, resolved);
  await writeManagedPublicEnvironment(root, {
    LOOM_URL: resolved.public.serviceUrl,
    NEON_AUTH_URL: resolved.public.authUrl ?? null,
  });
  // Public coordinates are outside release identity; immutable server artifacts remain unchanged.
  await publishProjectConfiguration(root, release.version, resolved.public);
}
