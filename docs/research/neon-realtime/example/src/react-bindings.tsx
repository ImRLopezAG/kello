// Research-only: proves the official React and TanStack DB adapters accept
// the sealed query and refresh callback shapes the wrapper would hand them.
import { createElement } from "react";
import { RealtimeProvider, useLiveQuery } from "@neon/realtime-react";
import { realtimeCollectionOptions } from "@neon/realtime-tanstack";
import { createCollection } from "@tanstack/db";
import type { RealtimeClient, SealedLiveQuery } from "@neon/realtime/client";
import type { MessageRow } from "./server";
import type { MutationReceipt } from "./server";

export function Messages(props: {
  readonly query: SealedLiveQuery<MessageRow>;
  readonly refreshQuery: () => Promise<SealedLiveQuery<MessageRow>>;
}) {
  const { data, status, utils } = useLiveQuery(props.query, { refreshQuery: props.refreshQuery });
  void utils.awaitTxId;
  return createElement(
    "ul",
    { "data-status": status },
    data?.map((row) => createElement("li", { key: row.id }, row.body)),
  );
}

export function Root(props: { readonly client: RealtimeClient; readonly children: React.ReactNode }) {
  return createElement(RealtimeProvider, { client: props.client, children: props.children });
}

/** TanStack DB collection. Note `utils.awaitTxId` resolves `boolean` here, not `void`. */
export function messagesCollection(
  client: RealtimeClient,
  query: SealedLiveQuery<MessageRow>,
  refreshQuery: () => Promise<SealedLiveQuery<MessageRow>>,
  send: (body: string) => Promise<MutationReceipt<{ id: string }>>,
) {
  return createCollection(
    realtimeCollectionOptions<MessageRow, string>({
      id: "messages",
      client,
      query,
      refreshQuery,
      getKey: (row) => row.id,
      onInsert: async ({ transaction, collection }) => {
        for (const mutation of transaction.mutations) {
          const receipt = await send(mutation.modified.body);
          if (receipt.kind === "committed") {
            const seen: boolean = await collection.utils.awaitTxId(receipt.txid, 10_000);
            void seen;
          }
        }
      },
    }),
  );
}
