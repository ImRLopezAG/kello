"use client";
import { Suspense, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KelloProvider, useKello, auth, serviceUrl } from "../lib/kello";
import type { Notes } from "../lib/kello";
import * as v from "valibot";
export function NoteList({ notes }: { notes: Readonly<Notes> }) {
  return (
    <ul aria-label="Latest 50 notes">
      {notes.map((note) => (
        <li key={note._id}>{note.text}</li>
      ))}
    </ul>
  );
}
export function NotesPanel() {
  return (
    <KelloProvider
      url={serviceUrl}
      ssrFallback={<p role="status">Loading application…</p>}
      loadingFallback={<p role="status">Loading session…</p>}
      fallback={<SignIn />}
    >
      <Suspense fallback={<p role="status">Loading notes…</p>}>
        <ConnectedNotes />
      </Suspense>
    </KelloProvider>
  );
}
function ConnectedNotes() {
  const { rpc, api } = useKello();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const greeting = useQuery(rpc.examples.greeting.queryOptions({ input: { name: "TanStack Start" } }));
  const live = api.examples.watch.useLiveQuery();
  const save = useMutation(rpc.examples.add.mutationOptions());
  return (
    <section>
      {greeting.data && <p>Signed in as {greeting.data.owner}</p>}
      <p role="status">
        {live.status === "error" || live.status === "closed"
          ? "Live connection unavailable"
          : live.isPending
            ? "Connecting live updates…"
            : "Live updates connected"}
      </p>
      <NoteList notes={live.data ?? []} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const text = new FormData(form).get("text");
          const input = v.safeParse(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)), text);
          if (input.success) save.mutate({ text: input.output }, { onSuccess: () => form.reset() });
        }}
      >
        <label>
          New note <input name="text" required maxLength={200} />
        </label>
        <button type="submit" disabled={save.isPending}>
          Add note
        </button>
      </form>
      {save.isError && <p role="alert">The request failed. Your session may have expired.</p>}
      <button
        type="button"
        onClick={async () => {
          try {
            const result = await auth.signOut();
            if (result.error) throw new Error("Sign out failed");
          } catch {
            setSignOutFailed(true);
          }
        }}
      >
        Sign out
      </button>
      {signOutFailed && <p role="alert">Could not sign out. Try again.</p>}
    </section>
  );
}
export function SignIn() {
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const [register, setRegister] = useState(false);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(false);
        const data = new FormData(event.currentTarget);
        const parsed = v.safeParse(v.object({ email: v.string(), password: v.string(), name: v.string() }), {
          email: data.get("email"),
          password: data.get("password"),
          name: data.get("name") ?? "",
        });
        if (!parsed.success) {
          setPending(false);
          setError(true);
          return;
        }
        try {
          const { email, password, name } = parsed.output;
          const result = register
            ? await auth.signUp.email({ email, password, name })
            : await auth.signIn.email({ email, password });
          if (result.error) throw new Error("Sign in failed");
        } catch {
          setError(true);
        } finally {
          setPending(false);
        }
      }}
    >
      {register && (
        <label>
          Name <input name="name" autoComplete="name" required />
        </label>
      )}
      <label>
        Email <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        Password <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <button type="submit" disabled={pending}>
        {register ? "Create account" : "Sign in"}
      </button>
      <button type="button" onClick={() => setRegister(!register)}>
        {register ? "Use an existing account" : "Create an account"}
      </button>
      {error && <p role="alert">Sign-in failed.</p>}
    </form>
  );
}
