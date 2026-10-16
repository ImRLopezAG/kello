"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { LiveQuerySnapshot } from "@neon/realtime/client";
import type {
  createNeonLiveClient,
  IssuedNeonQuery,
  NeonLiveSubscription,
  NeonMutationResult,
  NeonConfirmation,
} from "../client/realtime";

type Client = ReturnType<typeof createNeonLiveClient>;
/** Keep issue and rows referentially stable for one input. A new authenticated
 * session must own a new client; dispose that client on logout. Capabilities
 * stay effect-local and are never part of SSR or Query dehydration. */
export function useNeonLiveQuery<Row>(options: {
  readonly client: Client;
  readonly issue: () => Promise<IssuedNeonQuery<Row>>;
  readonly rows: StandardSchemaV1<unknown, readonly Row[]>;
}) {
  const { client, issue, rows } = options;
  const generation = useMemo(() => ({}), [client, issue, rows]);
  const current = useRef<{ generation: object; live: NeonLiveSubscription<Row> } | undefined>(undefined);
  const [state, setState] = useState<{ generation: object; snapshot?: LiveQuerySnapshot<Row>; failed: boolean }>();
  useEffect(() => {
    let active = true;
    let live: NeonLiveSubscription<Row> | undefined;
    let off: (() => void) | undefined;
    void issue()
      .then((issued) => {
        if (!active) return;
        live = client.open(issued, { rows, refresh: issue });
        current.current = { generation, live };
        const update = () => {
          if (active && live) setState({ generation, snapshot: live.getSnapshot(), failed: false });
        };
        off = live.subscribe(update);
        update();
      })
      .catch(() => {
        if (active) setState({ generation, failed: true });
      });
    return () => {
      active = false;
      off?.();
      live?.dispose();
      if (current.current?.generation === generation) current.current = undefined;
    };
  }, [client, generation, issue, rows]);
  const confirm = useCallback(
    async <Result>(receipt: NeonMutationResult<Result>, timeoutMs: number): Promise<NeonConfirmation> => {
      const owned = current.current;
      if (!owned || owned.generation !== generation) return "unknown";
      return owned.live.confirm(receipt, timeoutMs);
    },
    [generation],
  );
  const ownedState = state?.generation === generation ? state : undefined;
  return {
    snapshot: ownedState?.snapshot,
    failed: ownedState?.failed ?? false,
    confirm,
  };
}
