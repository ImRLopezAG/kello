/** Browser origins are exact, canonical origins. Missing Origin is reserved for non-browser callers. */
export function originPolicy(origins: readonly string[]): (origin: string | null) => boolean {
  const allowed = new Set(origins);
  for (const origin of allowed) {
    const address = new URL(origin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(address.hostname);
    if (address.origin !== origin || (address.protocol !== "https:" && !(address.protocol === "http:" && local)))
      throw new Error("Expected a canonical HTTPS origin or local development origin");
  }
  return (origin) => origin === null || allowed.has(origin);
}
