import type { NeonAuthConfig } from "@neondatabase/auth/server";

/** Server-only values are resolved per request, never serialized into client configuration. */
export function neonServerEnvironment() {
  const baseUrl = process.env.NEON_AUTH_BASE_URL;
  const secret = process.env.NEON_AUTH_COOKIE_SECRET;
  const url = process.env.LOOM_SERVICE_URL;
  if (!baseUrl || !secret || !url)
    throw new Error("Set NEON_AUTH_BASE_URL, NEON_AUTH_COOKIE_SECRET and LOOM_SERVICE_URL for server rendering");
  for (const value of [baseUrl, url]) {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error("Server integration requires HTTPS service URLs");
  }
  return { auth: { baseUrl, cookies: { secret } } satisfies NeonAuthConfig, url };
}
