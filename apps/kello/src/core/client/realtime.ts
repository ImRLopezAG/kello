import { createRealtimeClient, QueryRefreshController } from "@neon/realtime/client";
import type {
  LiveQuerySnapshot,
  MaterializedLiveQuerySubscription,
  RealtimeClient,
  SealedLiveQuery,
} from "@neon/realtime/client";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AnyNestedClient, Client } from "@orpc/client";

/** Live capabilities are deliberately excluded from ordinary Query utilities. */
export type OrdinaryLiveRouter<Router extends AnyNestedClient> =
  Router extends Client<infer _Context, infer _Input, infer Output, infer _Error>
    ? Output extends IssuedNeonQuery<unknown>
      ? never
      : Router
    : {
        [
          Key in keyof Router as Router[Key] extends Client<infer _Context, infer _Input, infer Output, infer _Error>
            ? Output extends IssuedNeonQuery<unknown>
              ? never
              : Key
            : Key
        ]: Router[Key] extends AnyNestedClient ? OrdinaryLiveRouter<Router[Key]> : never;
      };

export interface NeonScope {
  readonly database: string;
  readonly deployment: string;
}
/** Bearer capability: never log, persist, dehydrate, or put in a URL. */
export interface IssuedNeonQuery<Row> {
  readonly version: 1;
  readonly scope: NeonScope;
  readonly authorization: string;
  readonly sessionExpiresAt: number;
  readonly query: SealedLiveQuery<Row>;
}
export interface NeonMutationResult<Result> {
  readonly version: 1;
  readonly scope: NeonScope;
  readonly authorization: string;
  readonly transaction: { readonly kind: "committed"; readonly txid: string } | { readonly kind: "no-write" };
  readonly value: Result;
}
export type NeonConfirmation = "confirmed" | "no-write" | "unknown";
export type NeonObservation =
  | { readonly type: "state"; readonly state: "connecting" | "live" | "stale" | "closed" | "error" }
  | { readonly type: "renewal"; readonly outcome: "renewed" | "failed" }
  | { readonly type: "confirmation"; readonly outcome: NeonConfirmation; readonly durationMs: number };
export interface NeonLiveSubscription<Row> {
  getSnapshot(): LiveQuerySnapshot<Row>;
  subscribe(listener: () => void): () => void;
  confirm<Result>(receipt: NeonMutationResult<Result>, timeoutMs: number): Promise<NeonConfirmation>;
  dispose(): void;
}
function sameScope(a: NeonScope, b: NeonScope): boolean {
  return a.database === b.database && a.deployment === b.deployment;
}
/** One owner per authenticated browser session. Dispose on logout/session change.
 * Uses the official SDK's installed-progress tracker; no transaction history here. */
export function createNeonLiveClient(
  options: {
    readonly url: string;
    readonly observe?: (event: NeonObservation) => void;
  },
  sdk: RealtimeClient = createRealtimeClient({ url: options.url }),
) {
  const owners = new Set<() => void>();
  let closed = false;
  function observe(event: NeonObservation) {
    try {
      options.observe?.(event);
    } catch {
      /* observations cannot affect authority */
    }
  }
  return {
    open<Row>(
      initial: IssuedNeonQuery<Row>,
      settings: {
        readonly rows: StandardSchemaV1<unknown, readonly Row[]>;
        readonly refresh: () => Promise<IssuedNeonQuery<Row>>;
      },
    ): NeonLiveSubscription<Row> {
      if (closed) throw new Error("Realtime session closed");
      if (owners.size >= 100) throw new Error("Realtime subscription limit reached");
      if (
        !Number.isSafeInteger(initial.sessionExpiresAt) ||
        initial.sessionExpiresAt <= Date.now() ||
        !Number.isSafeInteger(initial.query.expiresAt) ||
        initial.query.expiresAt <= Date.now() ||
        initial.query.expiresAt > initial.sessionExpiresAt
      )
        throw new Error("Expired or invalid realtime session");
      if (initial.version !== 1) throw new Error("Unsupported realtime protocol");
      const scope = Object.freeze({ ...initial.scope });
      const binding = initial.authorization;
      const fingerprint = initial.query.queryFingerprint;
      const wire: MaterializedLiveQuerySubscription<Row> = sdk.subscribe(initial.query);
      const listeners = new Set<() => void>();
      // Entries stay admitted until the SDK waiter settles, even if the outward
      // answer becomes unknown earlier. Reconnection cannot recycle waiter slots.
      const pending = new Set<() => void>();
      let disposed = false;
      let expiryTimer: ReturnType<typeof setTimeout> | undefined;
      function expired() {
        return Date.now() >= initial.sessionExpiresAt;
      }
      function armExpiry() {
        if (expired()) {
          dispose();
          return;
        }
        expiryTimer = setTimeout(armExpiry, Math.min(initial.sessionExpiresAt - Date.now(), 2_147_483_647));
      }
      let snapshot: LiveQuerySnapshot<Row> = { status: "connecting", error: undefined, data: undefined };
      let publication = 0;
      function unknown() {
        for (const settle of Array.from(pending)) settle();
      }
      function notify() {
        for (const listener of Array.from(listeners)) {
          if (disposed) break;
          try {
            listener();
          } catch {
            /* Match SDK listener isolation. */
          }
        }
      }
      function dispose() {
        if (disposed) return;
        disposed = true;
        publication++;
        clearTimeout(expiryTimer);
        refresh.stop();
        off();
        unknown();
        snapshot = { status: "closed", error: undefined, data: undefined };
        for (const listener of Array.from(listeners)) {
          try {
            listener();
          } catch {}
        }
        listeners.clear();
        owners.delete(dispose);
        wire.unsubscribe();
      }
      const refresh = new QueryRefreshController<Row>({
        query: initial.query,
        subscription: wire,
        refreshQuery: async () => {
          let next: IssuedNeonQuery<Row>;
          try {
            next = await settings.refresh();
          } catch (cause) {
            dispose();
            throw cause;
          }
          if (
            disposed ||
            expired() ||
            next.sessionExpiresAt !== initial.sessionExpiresAt ||
            !Number.isSafeInteger(next.query.expiresAt) ||
            next.query.expiresAt <= Date.now() ||
            next.query.expiresAt > initial.sessionExpiresAt ||
            next.version !== 1 ||
            !sameScope(scope, next.scope) ||
            next.authorization !== binding ||
            next.query.queryFingerprint !== fingerprint
          ) {
            dispose();
            throw new Error("Realtime authorization or query changed");
          }
          return next.query;
        },
        renewSubscription: async (query) => {
          if (!disposed) await wire.renew(query);
        },
        onSubscriptionRenewed: () => {
          if (!disposed) observe({ type: "renewal", outcome: "renewed" });
        },
        onRefreshExhausted: () => {
          observe({ type: "renewal", outcome: "failed" });
          dispose();
        },
      });
      function install(next: LiveQuerySnapshot<Row>) {
        const revision = ++publication;
        if (next.status !== "live") unknown();
        let data: readonly Row[] | undefined;
        if (next.data !== undefined) {
          const parsed = settings.rows["~standard"].validate(next.data);
          if (parsed instanceof Promise) {
            void parsed.catch(() => {});
            throw new Error("Realtime row validation must be synchronous");
          }
          if (disposed || revision !== publication) return;
          if (parsed.issues) {
            dispose();
            return;
          }
          data = parsed.value;
        }
        if (disposed || revision !== publication) return;
        snapshot = { ...next, data };
        observe({ type: "state", state: next.status });
        notify();
      }
      const off = wire.onChange((next) => {
        try {
          install(next);
        } catch {
          dispose();
        }
      });
      owners.add(dispose);
      try {
        install(wire.getSnapshot());
      } catch {
        dispose();
      }
      if (!disposed) {
        armExpiry();
        refresh.start();
      }
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          if (disposed) return () => {};
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async confirm(receipt, timeoutMs) {
          const started = performance.now();
          const result = (outcome: NeonConfirmation) => {
            observe({ type: "confirmation", outcome, durationMs: Math.max(0, performance.now() - started) });
            return outcome;
          };
          if (expired()) dispose();
          if (
            disposed ||
            receipt.version !== 1 ||
            !sameScope(scope, receipt.scope) ||
            receipt.authorization !== binding ||
            !Number.isInteger(timeoutMs) ||
            timeoutMs <= 0 ||
            timeoutMs > 2_147_483_647
          )
            return result("unknown");
          if (receipt.transaction.kind === "no-write") return result("no-write");
          if (pending.size >= 32 || snapshot.status !== "live") return result("unknown");
          const txid = receipt.transaction.txid;
          return new Promise<NeonConfirmation>((resolve) => {
            let settled = false;
            const settle = (outcome: NeonConfirmation) => {
              if (!settled) {
                settled = true;
                resolve(result(outcome));
              }
            };
            const cancel = () => settle("unknown");
            pending.add(cancel);
            // SDK resolution guarantees its materialization, but Kello must also
            // finish its runtime projection before confirming installed rows.
            void wire
              .awaitTxId(txid, timeoutMs)
              .then(() => {
                install(wire.getSnapshot());
                // Promise reactions may beat an overdue disposal timer. Validate
                // after projection/listener reentry at the confirmation boundary.
                if (expired()) dispose();
                settle(!disposed && snapshot.status === "live" ? "confirmed" : "unknown");
              }, cancel)
              .catch(cancel)
              .finally(() => pending.delete(cancel));
          });
        },
        dispose,
      };
    },
    dispose() {
      if (closed) return;
      closed = true;
      for (const dispose of Array.from(owners)) dispose();
      sdk.close();
    },
  };
}
