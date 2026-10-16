import { retireProjectReleaseDatabase } from "kello/tooling";

export async function retireDatabaseCommand(root: string, file: string, structured: boolean): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const receipt = await retireProjectReleaseDatabase(root, file, undefined, controller.signal);
    console.log(
      structured
        ? JSON.stringify({ ok: true, command: "retire database", receipt })
        : `Retired database authority for ${receipt.deployment} (${receipt.version}). Provider resources remain.`,
    );
    return 0;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
