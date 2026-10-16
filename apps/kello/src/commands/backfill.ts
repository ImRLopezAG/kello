import { applyProjectBackfill } from "kello/tooling";

export async function backfillApplyCommand(
  root: string,
  file: string,
  input: { readonly runtimeRole: string; readonly reviewedHash: string; readonly maxBatches: number | undefined },
  structured: boolean,
): Promise<number> {
  const { runtimeRole, reviewedHash, maxBatches } = input;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const options = {
      runtimeRole,
      reviewedHash,
      signal: controller.signal,
    };
    const receipt = await applyProjectBackfill(
      root,
      file,
      maxBatches === undefined ? options : { ...options, maxBatches },
    );
    console.log(
      structured ? JSON.stringify({ ok: true, command: "backfill apply", receipt }) : JSON.stringify(receipt, null, 2),
    );
    return 0;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
