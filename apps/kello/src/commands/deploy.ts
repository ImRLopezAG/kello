import { deployProjectRelease, planProjectRelease } from "kello/tooling";

export async function deployCommand(root: string, file: string, structured: boolean, dryRun: boolean): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (dryRun) {
      const plan = await planProjectRelease(root, file, undefined, controller.signal);
      const ok = plan.blockers.length === 0;
      console.log(structured ? JSON.stringify({ ok, command: "deploy", plan }) : JSON.stringify(plan, null, 2));
      return ok ? 0 : 5;
    }
    const receipt = await deployProjectRelease(root, file, undefined, controller.signal);
    console.log(
      structured
        ? JSON.stringify({ ok: true, command: "deploy", receipt })
        : `Deployed ${receipt.identity.deployment} (${receipt.identity.version}) to ${receipt.identity.target.branchId}.`,
    );
    return 0;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
