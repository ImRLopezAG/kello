import { createStorageClient } from "./storage";
import type { RpcTransportOptions } from "./rpc-transport";
import { abortable } from "../adapters/neon/abortable";

/** Shares the provider's pinned credential and teardown with its RPC peer. */
export function createSessionStorage(options: RpcTransportOptions, shutdown: AbortSignal) {
  const identityKey = options.cachePrefix ?? `loom:${crypto.randomUUID()}`;
  return createStorageClient({
    url: options.url,
    signal: shutdown,
    async getAuth({ signal }) {
      const active = AbortSignal.any([signal, shutdown]);
      active.throwIfAborted();
      const token = await abortable(options.getToken(), active);
      active.throwIfAborted();
      return token ? { token, identityKey } : null;
    },
  });
}
