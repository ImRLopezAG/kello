import { useEffect, useRef, useState } from "react";
import * as v from "valibot";
import { createRoot } from "react-dom/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createKelloNeonReact } from "kello/react/neon";
import { configuration } from "../kello/_generated/api";
import { createClient } from "../kello/_generated/react";
import { SignIn } from "./sign-in";
import "./style.css";

const serviceUrl = import.meta.env.VITE_LOOM_URL ?? configuration.serviceUrl;
const kello = serviceUrl ? createKelloNeonReact(createClient, { serviceUrl }) : undefined;

type Connection = ReturnType<NonNullable<typeof kello>["useKello"]>;
type Entries = readonly { readonly _id: string; readonly text: string }[];

function EntryList({ entries, status }: { entries: Entries | undefined; status: string }) {
  return (
    <>
      <p role="status">{status}</p>
      {!entries && <p>Loading entries…</p>}
      {entries?.length === 0 && <p>No entries yet. Save your first thought above.</p>}
      <ul>
        {entries?.map((entry) => (
          <li key={entry._id}>{entry.text}</li>
        ))}
      </ul>
    </>
  );
}

/** Mounted only while live; unmounting disposes the Neon subscription. */
function LiveEntries({ api, onRows }: { api: Connection["api"]; onRows: (rows: Entries) => void }) {
  const live = api.journal.watch.useLiveQuery();
  useEffect(() => {
    if (live.data) onRows(live.data);
  }, [live.data, onRows]);
  return (
    <EntryList
      entries={live.data}
      status={
        live.status === "error" || live.status === "closed"
          ? "Live updates unavailable."
          : live.isPending
            ? "Connecting live updates…"
            : "Live updates active."
      }
    />
  );
}

function Journal({ bindings }: { bindings: NonNullable<typeof kello> }) {
  const { rpc, api } = bindings.useKello();
  const cache = useQueryClient();
  const [paused, setPaused] = useState(false);
  const [message, setMessage] = useState("");
  const snapshotOptions = rpc.journal.list.queryOptions();
  const snapshot = useQuery({ ...snapshotOptions, enabled: paused });
  const add = useMutation(rpc.journal.add.mutationOptions());
  const latest = useRef<Entries | undefined>(undefined);
  return (
    <main>
      <header>
        <p>Kello component example</p>
        <h1>Your journal</h1>
        <p>Save a thought. Open a second tab to see new entries arrive.</p>
        <button
          onClick={async () => {
            try {
              const result = await bindings.auth.signOut();
              if (result.error) setMessage("Could not sign out. Try again.");
            } catch {
              setMessage("Could not sign out. Try again.");
            }
          }}
        >
          Sign out
        </button>
      </header>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (add.isPending) return;
          const form = event.currentTarget;
          const text = new FormData(form).get("text");
          if (!v.is(v.string(), text) || !text.trim()) return;
          setMessage("");
          try {
            await add.mutateAsync({ text });
            await cache.invalidateQueries({ queryKey: snapshotOptions.queryKey });
            form.reset();
          } catch (cause) {
            setMessage(cause instanceof Error ? cause.message : "Could not save entry. Try again.");
          }
        }}
      >
        <label htmlFor="entry">New entry</label>
        <textarea id="entry" name="text" maxLength={200} required />
        <button disabled={add.isPending}>{add.isPending ? "Saving…" : "Save entry"}</button>
      </form>
      {message && <p role="alert">{message}</p>}
      <section aria-label="Recent entries">
        <h2>Recent entries</h2>
        {paused ? (
          <EntryList entries={snapshot.data} status="Live updates paused." />
        ) : (
          <LiveEntries
            api={api}
            onRows={(rows) => {
              latest.current = rows;
            }}
          />
        )}
        <button
          onClick={() => {
            if (!paused && latest.current) cache.setQueryData(snapshotOptions.queryKey, [...latest.current]);
            setPaused(!paused);
          }}
        >
          {paused ? "Resume live updates" : "Pause live updates"}
        </button>
        {snapshot.error && <p role="alert">{snapshot.error.message}</p>}
        <small>Showing up to 50 recent entries.</small>
      </section>
    </main>
  );
}

function App() {
  if (!kello || !serviceUrl)
    return (
      <main>
        <h1>Connect your journal</h1>
        <p>Run kello link and deploy, then set VITE_LOOM_URL.</p>
      </main>
    );
  return (
    <kello.KelloProvider url={serviceUrl} fallback={<SignIn auth={kello.auth} />}>
      <Journal bindings={kello} />
    </kello.KelloProvider>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<App />);
