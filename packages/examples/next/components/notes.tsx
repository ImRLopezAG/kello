"use client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KelloProvider, useKello, auth, serviceUrl } from "../lib/kello";
import type { KelloHydration } from "kello/client";
import type { Notes } from "../lib/kello";
import { z } from "zod";
export function NoteList({ notes }: { notes: Notes }) {
  return (
    <ul aria-label="Latest 50 notes">
      {notes.map((note) => (
        <li key={note._id}>{note.text}</li>
      ))}
    </ul>
  );
}
export function NotesPanel({ initialNotes = [], hydration }: { initialNotes?: Notes; hydration?: KelloHydration }) {
  return (
    <KelloProvider
      url={serviceUrl}
      {...(hydration ? { hydration } : {})}
      ssrFallback={<NoteList notes={initialNotes} />}
      loadingFallback={<p role="status">Loading session…</p>}
      fallback={<SignIn />}
    >
      <ConnectedNotes />
    </KelloProvider>
  );
}
function ConnectedNotes() {
  const { rpc, api } = useKello();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const greeting = useQuery(rpc.examples.greeting.queryOptions({ input: { name: "Next.js" } }));
  const notes = api.examples.watch.useLiveQuery();
  const save = useMutation(rpc.examples.add.mutationOptions());
  return (
    <section>
      {greeting.data && <p>Signed in as {greeting.data.owner}</p>}
      <p role="status">
        {notes.status === "error" ? "Notes unavailable" : notes.data ? "Notes loaded" : "Loading notes…"}
      </p>
      <NoteList notes={notes.data ?? []} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const text = new FormData(form).get("text");
          const input = z.string().trim().min(1).max(200).safeParse(text);
          if (input.success)
            save.mutate(
              { text: input.data },
              {
                onSuccess: () => {
                  form.reset();
                },
              },
            );
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
        const parsed = z
          .object({ email: z.string(), password: z.string(), name: z.string() })
          .safeParse({ email: data.get("email"), password: data.get("password"), name: data.get("name") ?? "" });
        if (!parsed.success) {
          setPending(false);
          setError(true);
          return;
        }
        try {
          const { email, password, name } = parsed.data;
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
