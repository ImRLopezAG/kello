/** Bounds read-only provider observations even when an SDK does not accept an AbortSignal. */
export async function readWithSignal<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return read();
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(new Error("Function observation aborted"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([read(), cancelled.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
