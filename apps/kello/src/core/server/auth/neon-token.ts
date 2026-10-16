import type { NeonAuthServer } from "@neondatabase/auth/server";

/** Server sessions contain an opaque cookie token; the SDK token endpoint supplies the signed backend JWT. */
export async function neonServerToken(auth: Pick<NeonAuthServer, "getSession" | "token">): Promise<string | null> {
  const session = await auth.getSession();
  if (session.error) throw new Error("Neon server session unavailable");
  if (!session.data) return null;
  const token = await auth.token();
  if (token.error || !token.data?.token) throw new Error("Neon server token unavailable");
  return token.data.token;
}
