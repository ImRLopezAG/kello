import type { ReactBetterAuthClient } from "@neondatabase/auth";
import * as v from "valibot";

const tokenResponse = v.object({ token: v.pipe(v.string(), v.minLength(1)) });

/** Bind credential retrieval to the provider session that owns this connection. */
export async function neonClientToken(
  auth: ReactBetterAuthClient,
  subject: string,
  sessionId: string,
  endpoint: false | { readonly url: string; readonly credentials: "include" | "same-origin" },
) {
  const current = await auth.getSession();
  if (current.error) throw new Error("Neon session refresh failed");
  if (current.data?.user.id !== subject || current.data.session.id !== sessionId) return null;
  if (!endpoint) return current.data.session.token || null;
  // Neon 0.5.0-beta's browser token() hook throws before fetching. The official
  // server route still owns credential validation, refresh, and cookie handling.
  const response = await fetch(endpoint.url, {
    credentials: endpoint.credentials,
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Neon token refresh failed");
  const data = v.safeParse(tokenResponse, await response.json());
  if (!data.success) throw new Error("Neon token refresh failed");
  return data.output.token;
}
