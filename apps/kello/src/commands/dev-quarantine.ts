import { quarantineProjectDevelopment } from "kello/tooling";

export async function devQuarantineCommand(root: string, file: string, structured: boolean): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const receipt = await quarantineProjectDevelopment(root, file, undefined, controller.signal);
    console.log(
      structured
        ? JSON.stringify({ ok: true, command: "dev quarantine", receipt })
        : `Quarantined database on ${receipt.branchId}: revoked ${receipt.revokedGrants} grants and cancelled ${receipt.cancelledJobs} jobs. Provider triggers are unchanged.`,
    );
    return 0;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
