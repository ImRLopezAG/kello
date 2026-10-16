export class RequestBodyError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE") {
    super(code);
  }
}

export async function readRequestBody(request: Request, limit: number, signal: AbortSignal): Promise<string> {
  if (!request.body) throw new RequestBodyError("INVALID_REQUEST");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new RequestBodyError("PAYLOAD_TOO_LARGE");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (cause) {
    if (cause instanceof RequestBodyError || signal.aborted) throw cause;
    throw new RequestBodyError("INVALID_REQUEST");
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
