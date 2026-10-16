import { planProjectBranchProvision, provisionProjectBranch } from "kello/tooling";

export async function provisionCommand(
  root: string,
  file: string,
  structured: boolean,
  dryRun: boolean,
): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (dryRun) {
      const plan = await planProjectBranchProvision(root, file, undefined, controller.signal);
      console.log(
        structured ? JSON.stringify({ ok: true, command: "provision", plan }) : JSON.stringify(plan, null, 2),
      );
    } else {
      const receipt = await provisionProjectBranch(root, file, undefined, controller.signal);
      console.log(
        structured
          ? JSON.stringify({ ok: true, command: "provision", receipt })
          : `Provisioned branch ${receipt.branchId} with endpoint ${receipt.endpointId}. Database preparation and release activation are still required.`,
      );
    }
    return 0;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
