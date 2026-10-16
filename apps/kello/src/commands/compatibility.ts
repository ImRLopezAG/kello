import { declareProjectCompatibility } from "kello/tooling";

export async function compatibilityCommand(root: string, file: string, structured: boolean): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const receipt = await declareProjectCompatibility(root, file, undefined, controller.signal);
    console.log(
      structured
        ? JSON.stringify({ ok: true, command: "migrations declare-compatibility", receipt })
        : `Declared compatibility for ${receipt.deployment} (${receipt.version}). No migrations applied.`,
    );
    return 0;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
