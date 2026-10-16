import { mkdir, readFile, lstat } from "node:fs/promises";
import * as v from "valibot";
import { loadProjectConfig } from "./load";
import { createKelloNeonClient } from "../neon/api";
import { withProjectConfigurationLock } from "../config/environment-file";
import { resolveProjectPath } from "../config/paths";
import { readResolvedProject } from "../config/resolve";
import { writeReceiptFile } from "../deploy/receipt-file";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/));
const request = v.strictObject({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  orgId: identifier,
  region: identifier,
});
const receiptSchema = v.strictObject({
  format: v.literal(1),
  operation: v.pipe(v.string(), v.uuid()),
  request,
  phase: v.picklist(["prepared", "attempted", "identified", "complete"]),
  projectId: v.optional(identifier),
});
export interface OnboardingProvider {
  organizations(): Promise<readonly { id: string; name: string }[]>;
  projects(orgId: string): Promise<readonly { id: string; name: string; orgId: string }[]>;
  create(input: { name: string; orgId: string; region: string }): Promise<{ id: string }>;
  rename(id: string, name: string): Promise<void>;
}
export class OnboardingError extends Error {
  constructor(
    readonly code: "ONBOARDING_CONFLICT" | "ONBOARDING_RECONCILE" | "ONBOARDING_SELECTION" | "ONBOARDING_REJECTED",
    message: string,
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}
export function createOnboardingProvider(): OnboardingProvider {
  const client = createKelloNeonClient();
  return {
    organizations: () => client.user.organizations(),
    projects: async (orgId) =>
      (await client.projects.list({ org_id: orgId }).all()).map(({ id, name, org_id }) => ({
        id,
        name,
        orgId: org_id ?? "",
      })),
    create: ({ name, orgId, region }) =>
      client.projects.create({ name, org_id: orgId, region_id: region, pg_version: 18 }),
    rename: async (projectId, name) => {
      await client.projects.update({ projectId, name });
    },
  };
}

/** A persisted attempt is reconciled by its unique temporary name, never replayed. */
export async function createNeonProject(
  root: string,
  input: v.InferInput<typeof request>,
  provider: OnboardingProvider = createOnboardingProvider(),
) {
  const parsed = v.parse(request, input);
  await mkdir(root, { recursive: true });
  return withProjectConfigurationLock(root, async () => {
    const directory = await resolveProjectPath(root, ".loom");
    const path = await resolveProjectPath(root, ".loom/onboarding.json");
    let receipt: v.InferOutput<typeof receiptSchema>;
    try {
      receipt = v.parse(receiptSchema, JSON.parse(await readFile(path, "utf8")));
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
        throw new OnboardingError("ONBOARDING_CONFLICT", "Invalid onboarding receipt. Inspect it before retrying.");
      const { config } = await loadProjectConfig(root);
      const linked = await lstat(await resolveProjectPath(root, ".neon")).then(
        () => true,
        (cause: unknown) => {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
          throw cause;
        },
      );
      if (
        linked ||
        (await readResolvedProject(root)) ||
        config.projectId ||
        config.provider?.projectId ||
        process.env.NEON_PROJECT_ID
      )
        throw new OnboardingError(
          "ONBOARDING_CONFLICT",
          "This directory already selects a project. Use link or create in a different directory.",
        );
      receipt = { format: 1, operation: crypto.randomUUID(), request: parsed, phase: "prepared" };
    }
    if (JSON.stringify(receipt.request) !== JSON.stringify(parsed))
      throw new OnboardingError(
        "ONBOARDING_CONFLICT",
        "This directory has a different project creation operation. Resume its original arguments.",
      );
    const save = () => writeReceiptFile(directory, "onboarding.json", JSON.stringify(receipt, null, 2) + "\n");
    const temporaryName = `loom-${receipt.operation}`;
    if (receipt.phase === "prepared") {
      receipt.phase = "attempted";
      await save();
      try {
        const project = await provider.create({ ...parsed, name: temporaryName });
        receipt.projectId = v.parse(identifier, project.id);
      } catch (cause) {
        const rejection = v.safeParse(
          v.object({ kind: v.picklist(["api", "auth"]), status: v.picklist([400, 401, 403, 422]) }),
          cause,
        );
        if (rejection.success) {
          receipt.phase = "prepared";
          await save();
          throw new OnboardingError(
            "ONBOARDING_REJECTED",
            `Neon rejected project creation (HTTP ${rejection.output.status}). Check project quota, permissions, and configuration, then retry.`,
          );
        }
        throw new OnboardingError(
          "ONBOARDING_RECONCILE",
          `Project creation outcome is uncertain${v.is(v.object({ status: v.number() }), cause) ? ` (HTTP ${cause.status})` : ""}. Retry these arguments to reconcile; Kello will not issue another create.`,
        );
      }
      receipt.phase = "identified";
      await save();
    }
    if (!receipt.projectId) {
      const matches = (await provider.projects(parsed.orgId)).filter(
        (project) => project.name === temporaryName && project.orgId === parsed.orgId,
      );
      if (matches.length !== 1 || !matches[0])
        throw new OnboardingError(
          "ONBOARDING_RECONCILE",
          "Cannot reconcile the recorded create yet. Inspect the Neon organization and onboarding receipt; no second create was sent.",
        );
      receipt.projectId = v.parse(identifier, matches[0].id);
      receipt.phase = "identified";
      await save();
    }
    if (receipt.phase !== "complete") {
      await provider.rename(receipt.projectId, parsed.name);
      receipt.phase = "complete";
      await save();
    }
    return { projectId: receipt.projectId, operation: receipt.operation };
  });
}
