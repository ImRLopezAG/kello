import { expect, test, vi } from "vite-plus/test";
import { createSessionStorage } from "../../../apps/kello/src/core/client/session-storage";

test("storage cannot expose a delayed old-session response or run after teardown", async () => {
  const shutdown = new AbortController();
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() => pending);
  const token = vi.fn(async () => "credential");
  const storage = createSessionStorage(
    { url: "https://service.test", version: "a".repeat(64), getToken: token, cachePrefix: "loom:alice" },
    shutdown.signal,
  );
  try {
    const result = storage.status("00000000-0000-4000-8000-000000000001");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    shutdown.abort(new Error("session ended"));
    resolve(new Response("{}", { headers: { "content-type": "application/json" } }));
    await expect(result).rejects.toThrow();
    await expect(storage.status("00000000-0000-4000-8000-000000000001")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    fetcher.mockRestore();
  }
});
