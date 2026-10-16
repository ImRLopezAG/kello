import { AsyncLocalStorage } from "node:async_hooks";
import { ORPCError } from "@orpc/server";
import type { InvocationContext } from "../auth/context";
import type { createStorageIntents } from "./intents";
import type { StorageUpload } from "./contracts";
import { StorageIntentError, StorageVerificationError } from "./contracts";
import { ownRpcDatabaseWork } from "../rpc/database";

type Intents = ReturnType<typeof createStorageIntents>;

/** Authenticated control-plane operations. Identity and cancellation belong to
 * the invocation and cannot be supplied by application arguments. */
export interface InvocationStorage {
  create(upload: StorageUpload, requestKey: string): ReturnType<Intents["create"]>;
  status(id: string): ReturnType<Intents["status"]>;
  signUpload(id: string): ReturnType<Intents["signUpload"]>;
  finalize(id: string): ReturnType<Intents["finalize"]>;
  signDownload(id: string): ReturnType<Intents["signDownload"]>;
}

interface StorageScope {
  readonly service: InvocationStorage;
}
const current = new AsyncLocalStorage<StorageScope>();
const unavailable = (): Promise<never> => Promise.reject(new ORPCError("STORAGE_UNAVAILABLE"));
const unavailableStorage: InvocationStorage = Object.freeze({
  create: unavailable,
  status: unavailable,
  signUpload: unavailable,
  finalize: unavailable,
  signDownload: unavailable,
});

export function invocationStorage(): InvocationStorage {
  return current.getStore()?.service ?? unavailableStorage;
}

/** Drain started work even if its handler forgets to await it. Storage owns
 * independent transactions, so it cannot run inside a retryable DB procedure. */
export async function withInvocationStorage<T>(
  context: InvocationContext,
  intents: Intents | undefined,
  databasePolicy: "read" | "write" | "single-attempt-write" | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const identity = context.identity ? Object.freeze({ ...context.identity }) : null;
  const pending = new Set<Promise<void>>();
  let active = true;
  let failure: Error | undefined;
  function own<Value>(work: (backend: Intents, owner: NonNullable<typeof identity>) => Promise<Value>): Promise<Value> {
    const result = (async () => {
      if (!active || current.getStore() !== scope) throw new Error("Storage invocation has ended");
      context.signal.throwIfAborted();
      if (databasePolicy === "write")
        return ownRpcDatabaseWork(async () => {
          throw new ORPCError("FORBIDDEN", { message: "Storage requires a non-transactional procedure" });
        });
      if (databasePolicy === "read")
        throw new ORPCError("FORBIDDEN", { message: "Storage requires a non-transactional procedure" });
      const perform = async () => {
        if (!identity) throw new ORPCError("UNAUTHORIZED");
        if (!intents) throw new ORPCError("STORAGE_UNAVAILABLE");
        return work(intents, identity).catch((cause) => {
          if (cause instanceof StorageIntentError) throw new ORPCError(cause.code);
          if (cause instanceof StorageVerificationError) throw new ORPCError("STORAGE_UNAVAILABLE");
          throw cause;
        });
      };
      // Automatic handlers are never retried. Still join their work ownership
      // so caught or unawaited storage failures abort the database transaction.
      const value = await (databasePolicy === "single-attempt-write" ? ownRpcDatabaseWork(perform) : perform());
      context.signal.throwIfAborted();
      return value;
    })();
    const tracked = result
      .then(
        () => undefined,
        (cause) => {
          failure = cause instanceof Error ? cause : new Error("Storage operation failed");
        },
      )
      .finally(() => pending.delete(tracked));
    pending.add(tracked);
    return result;
  }
  const service = Object.freeze<InvocationStorage>({
    create: (upload, key) => own((backend, owner) => backend.create(owner, upload, key, context.signal)),
    status: (id) => own((backend, owner) => backend.status(owner, id, context.signal)),
    signUpload: (id) => own((backend, owner) => backend.signUpload(owner, id, context.signal)),
    finalize: (id) => own((backend, owner) => backend.finalize(owner, id, context.signal)),
    signDownload: (id) => own((backend, owner) => backend.signDownload(owner, id, context.signal)),
  });
  const scope: StorageScope = { service };
  return current.run(scope, async () => {
    let value: T;
    try {
      value = await operation();
    } finally {
      active = false;
      while (pending.size) await Promise.all(pending);
    }
    if (failure) throw failure;
    return value;
  });
}
