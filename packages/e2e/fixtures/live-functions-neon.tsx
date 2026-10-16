import React, { useState } from "react";
import { createRoot } from "react-dom/client";
// Bun fixture resolver binds this to the real freshly generated public module.
// @ts-expect-error Resolved by the fixture's bundler, not a published package.
import { createClient } from "acceptance-generated-react";
import * as v from "valibot";
const config = v.parse(v.object({ token: v.string(), url: v.string() }), await (await fetch("/bootstrap")).json());
const connection = createClient({
  url: location.origin,
  realtimeUrl: config.url,
  getToken: async () => config.token,
  cachePrefix: "fixture-login",
});
function App() {
  const [after, setAfter] = useState<string>();
  const [result, setResult] = useState("idle");
  interface PageInput {
    limit: number;
    after?: string;
  }
  const input: PageInput = { limit: 1 };
  if (after !== undefined) input.after = after;
  const live = connection.api.tasks.list.useLiveQuery(input);
  async function update() {
    setResult("pending");
    try {
      const response = await fetch("/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "alpha-updated" }),
      });
      if (!response.ok) {
        setResult("unknown");
        return;
      }
      const receipt = await response.json();
      setResult(await live.confirm(receipt, 15_000));
    } catch {
      setResult("unknown");
    }
  }
  return (
    <main>
      <h1>Generated live functions</h1>
      <p id="status">{live.status}</p>
      <p id="rows">{JSON.stringify(live.data)}</p>
      <p id="result">{result}</p>
      <button disabled={live.status === "closed" || result === "pending"} onClick={() => void update()}>
        Update and confirm
      </button>
      <button onClick={() => setAfter("alpha-updated")}>Next page</button>
      <button onClick={() => setAfter(undefined)}>First page</button>
      <button onClick={() => live.refetch()}>Retry</button>
      <button
        onClick={() => {
          connection.dispose();
          setResult("disposed");
        }}
      >
        Logout
      </button>
      <button
        onClick={() =>
          void connection.client.tasks.list({ limit: 0 }).then(
            () => setResult("invalid-accepted"),
            () => setResult("invalid-rejected"),
          )
        }
      >
        Invalid input
      </button>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
