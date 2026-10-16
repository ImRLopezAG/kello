import { createInterface } from "node:readline/promises";
import { access, mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createNeonProject,
  createOnboardingProvider,
  initializeProject,
  integrateProject,
  loadProjectConfig,
  resolveNeonProject,
  saveResolvedProject,
  writeNeonLink,
  writeManagedPublicEnvironment,
  OnboardingError,
  ProjectResolutionError,
  resolveProjectPath,
} from "kello/tooling";

export interface OnboardingOptions {
  name?: string | undefined;
  orgId?: string | undefined;
  projectId?: string | undefined;
  region?: string | undefined;
  branch?: string | undefined;
  databaseName?: string | undefined;
  dryRun?: boolean | undefined;
  apply?: boolean | undefined;
  structured: boolean;
}
async function choose(
  label: string,
  choices: readonly { id: string; name: string }[],
  structured: boolean,
): Promise<string> {
  if (choices.length === 1 && choices[0]) return choices[0].id;
  const summary = choices.map(({ id, name }, index) => `${index + 1}. ${name} (${id})`).join("\n");
  if (!choices.length || structured || !process.stdin.isTTY || !process.stdout.isTTY || process.env.CI) {
    throw new OnboardingError("ONBOARDING_SELECTION", `Choose ${label} explicitly.\n${summary}`);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`Choose ${label} (blank cancels):\n${summary}\n> `);
    const choice = /^\d+$/.test(answer) ? choices[Number(answer) - 1] : undefined;
    if (!choice) throw new OnboardingError("ONBOARDING_SELECTION", "Selection cancelled; no project was created.");
    return choice.id;
  } finally {
    prompt.close();
  }
}
async function runOnboardingCommand(
  command: "create" | "link" | "integrate",
  root: string,
  options: OnboardingOptions,
) {
  if (command === "integrate") {
    const result = await integrateProject(root, options.apply ?? false);
    console.log(
      options.structured
        ? JSON.stringify({ ok: !result.collisions.length, command, ...result })
        : JSON.stringify(result, null, 2),
    );
    return result.collisions.length ? 3 : 0;
  }
  const provider = createOnboardingProvider();
  let projectId = options.projectId;
  if (command === "create") {
    if (!options.name || !options.region || projectId)
      throw new OnboardingError(
        "ONBOARDING_SELECTION",
        "create requires --name and --region; use link for an existing project.",
      );
    if (options.dryRun) {
      console.log(
        JSON.stringify({
          ok: true,
          command,
          dryRun: true,
          name: options.name,
          region: options.region,
          orgId: options.orgId,
        }),
      );
      return 0;
    }
    const orgId =
      options.orgId ?? (await choose("an organization (--org-id)", await provider.organizations(), options.structured));
    await mkdir(root, { recursive: true });
    const existingPackage = await access(join(root, "package.json")).then(
      () => true,
      () => false,
    );
    if (existingPackage) await integrateProject(root, true);
    else await initializeProject(root, options.name);
    projectId = (await createNeonProject(root, { name: options.name, region: options.region, orgId }, provider))
      .projectId;
  }
  const { config } = await loadProjectConfig(root);
  let resolved;
  const selection = { projectId, branch: options.branch, databaseName: options.databaseName };
  try {
    resolved = await resolveNeonProject(root, config, selection);
  } catch (cause) {
    if (!(cause instanceof ProjectResolutionError) || cause.code !== "PROJECT_REQUIRED") throw cause;
    const orgId =
      options.orgId ?? (await choose("an organization (--org-id)", await provider.organizations(), options.structured));
    projectId = await choose("a project (--project-id)", await provider.projects(orgId), options.structured);
    resolved = await resolveNeonProject(root, config, { ...selection, projectId });
  }
  if (!options.dryRun) {
    await writeNeonLink(root, resolved);
    await saveResolvedProject(root, resolved);
    await writeManagedPublicEnvironment(root, {
      NEON_PROJECT_ID: resolved.projectId,
      NEON_BRANCH_ID: resolved.branchId,
      LOOM_URL: resolved.public.serviceUrl ?? null,
      NEON_AUTH_URL: resolved.public.authUrl ?? null,
    });
  }
  console.log(
    options.structured
      ? JSON.stringify({ ok: true, command, dryRun: options.dryRun ?? false, project: resolved })
      : `${options.dryRun ? "Resolved" : "Linked"} ${resolved.projectId} / ${resolved.branchName}.`,
  );
  return 0;
}

export async function onboardingCommand(
  command: "create" | "link" | "integrate",
  root: string,
  options: OnboardingOptions,
) {
  if (options.dryRun || (command === "integrate" && !options.apply))
    return runOnboardingCommand(command, root, options);
  await mkdir(root, { recursive: true });
  const directory = await resolveProjectPath(root, ".loom");
  await mkdir(directory, { recursive: true });
  const lock = join(directory, "onboarding.lock");
  try {
    await mkdir(lock);
  } catch {
    throw new OnboardingError(
      "ONBOARDING_CONFLICT",
      "Another onboarding command holds .loom/onboarding.lock. If interrupted, inspect its receipt and stop the previous process before removing the lock.",
    );
  }
  try {
    return await runOnboardingCommand(command, root, options);
  } finally {
    await rmdir(lock);
  }
}
