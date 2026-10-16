// Research sketch: client-side confirmation and renewal helpers around the official SDK.
import { createRealtimeClient, QueryRefreshController } from "@neon/realtime/client";
import type { MaterializedLiveQuerySubscription, RealtimeClient, SealedLiveQuery } from "@neon/realtime/client";
import type { MutationReceipt } from "./server";

export interface LiveSubscription<Row> {
  readonly subscription: MaterializedLiveQuerySubscription<Row>;
  /** Stop renewals and close the wire subscription. Idempotent. */
  readonly dispose: () => void;
}

/**
 * Subscribe to a sealed query and keep it renewed by calling back into the
 * application RPC that re-authorizes and re-seals the same query.
 */
export function subscribeLive<Row>(
  client: RealtimeClient,
  initial: SealedLiveQuery<Row>,
  refreshQuery: () => Promise<SealedLiveQuery<Row>>,
  onRefreshExhausted: (error: Error) => void,
): LiveSubscription<Row> {
  const subscription = client.subscribe(initial);
  const controller = new QueryRefreshController<Row>({
    query: initial,
    refreshQuery,
    renewSubscription: (query) => subscription.renew(query),
    onRefreshExhausted: (cause) => onRefreshExhausted(cause instanceof Error ? cause : new Error(String(cause))),
    subscription,
  });
  controller.start();
  let disposed = false;
  return {
    subscription,
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.stop();
      subscription.unsubscribe();
    },
  };
}

export type Confirmation = "confirmed" | "unchanged" | "unknown";

/**
 * Bounded confirmation. `unknown` means the timeout elapsed or the subscription
 * closed; it never means the write rolled back.
 */
export async function confirmReceipt<Row, Result>(
  live: Pick<MaterializedLiveQuerySubscription<Row>, "awaitTxId">,
  receipt: MutationReceipt<Result>,
  timeoutMs: number,
): Promise<Confirmation> {
  if (receipt.kind === "unchanged") return "unchanged";
  try {
    await live.awaitTxId(receipt.txid, timeoutMs);
    return "confirmed";
  } catch {
    return "unknown";
  }
}

export function createClient(url: string): RealtimeClient {
  return createRealtimeClient({ url });
}
