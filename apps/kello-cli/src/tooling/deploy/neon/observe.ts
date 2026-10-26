/** Preserve only this caller's identifiable cancellation; unrelated failures still need redaction. */
export function rethrowSignalCancellation(cause: unknown, signal?: AbortSignal): void {
  if (
    signal?.aborted &&
    (cause === signal.reason ||
      (cause instanceof Error && cause.name === "AbortError" && cause.cause === signal.reason))
  )
    throw signal.reason;
}

/** Bounds read-only provider observations even when an SDK does not accept an AbortSignal. */
export async function readWithSignal<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return read();
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([read(), cancelled.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
