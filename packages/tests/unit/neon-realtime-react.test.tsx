import { expect, test } from "vite-plus/test";
import { useMemo, useState } from "react";
import type { IssuedNeonQuery, NeonMutationResult } from "../../../apps/kello/src/core/client/realtime";
import { renderToString } from "react-dom/server";
import { useNeonLiveQuery } from "../../../apps/kello/src/core/react/realtime";
import { createNeonLiveClient } from "../../../apps/kello/src/core/client/realtime";
import { exampleAuthority, taskRows } from "../fixtures/neon-realtime";

test("SSR neither issues nor subscribes and cannot serialize a capability", () => {
  const client = createNeonLiveClient(
    { url: "ws://unused" },
    {
      subscribe() {
        throw new Error("Unexpected SSR subscription");
      },
      close() {},
    },
  );
  const issue = async () => {
    throw new Error("Unexpected SSR issuance");
  };
  function Example() {
    const live = useNeonLiveQuery({ client, issue, rows: taskRows });
    return <output>{live.snapshot?.status ?? "loading"}</output>;
  }
  expect(renderToString(<Example />)).toBe("<output>loading</output>");
  client.dispose();
});
test("example refuses fabricated session authority and caps verified expiry", () => {
  const verified = { identity: { issuer: "issuer", subject: "subject", tenantId: "tenant" }, expiresAt: 200 };
  const login = { ...verified.identity, id: "server-login-generation", expiresAt: 300 };
  const signal = new AbortController().signal;
  expect(() => exampleAuthority(verified, undefined, signal)).toThrow("adapter required");
  expect(() => exampleAuthority(verified, { ...login, issuer: "other" }, signal)).toThrow();
  expect(() => exampleAuthority(verified, { ...login, subject: "other" }, signal)).toThrow();
  expect(() => exampleAuthority(verified, { ...login, tenantId: "other" }, signal)).toThrow();
  expect(exampleAuthority(verified, login, signal).expiresAt).toBe(200);
});

/** Client example: ordinary RPC methods supply issue/update. Pending UI is
 * retired only by this hook's current authorized subscription, never by mutation
 * success alone. Unknown remains explicit and refresh is a new subscription. */
export function TaskListExample(props: {
  client: ReturnType<typeof createNeonLiveClient>;
  issue: () => Promise<IssuedNeonQuery<{ id: string; title: string }>>;
  update: (input: {
    id: string;
    title: string;
    key: string;
  }) => Promise<NeonMutationResult<{ id: string; title: string }>>;
}) {
  const [refresh, setRefresh] = useState(0);
  const issue = useMemo(() => () => props.issue(), [props.issue, refresh]);
  const live = useNeonLiveQuery({ client: props.client, issue, rows: taskRows });
  const [edits, setEdits] = useState<Record<string, { key: string; state: string }>>({});
  async function edit(id: string, title: string) {
    const key = crypto.randomUUID();
    setEdits((old) => ({ ...old, [id]: { key, state: "Saving" } }));
    function settle(state: string) {
      setEdits((old) => (old[id]?.key === key ? { ...old, [id]: { key, state } } : old));
    }
    try {
      const receipt = await props.update({ id, title, key });
      settle("Committed; awaiting subscription");
      const outcome = await live.confirm(receipt, 5000);
      settle(outcome === "confirmed" || outcome === "no-write" ? "" : "Committed; confirmation unknown");
    } catch {
      settle("Mutation rejected");
    }
  }
  if (live.failed) return <p>Live query unavailable</p>;
  if (!live.snapshot) return <p>Loading</p>;
  return (
    <section>
      <p>{live.snapshot.status === "live" ? "Live" : "Reconnecting; showing last installed rows"}</p>
      {live.snapshot.data?.length === 0 ? (
        <p>No tasks</p>
      ) : (
        <ul>
          {live.snapshot.data?.map((task) => (
            <li key={task.id}>
              {task.title} <button onClick={() => void edit(task.id, task.title + "!")}>Edit</button>
              <span role="status">{edits[task.id]?.state}</span>
            </li>
          ))}
        </ul>
      )}
      <button onClick={() => setRefresh((n) => n + 1)}>Refresh unknown confirmation</button>
    </section>
  );
}
