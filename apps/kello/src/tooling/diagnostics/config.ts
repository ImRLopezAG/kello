/** Private, side-effect-free validation shared by explicit CLI consent and transport. */
export function validateOtlpConfig(options: { endpoint: string; bearerToken?: string }) {
  try {
    const endpoint = new URL(options.endpoint);
    // Inspect the configured authority too: URL normalizes shorthand/numeric IPv4.
    const authority = /^https?:\/\/([^/?#]+)\/[^?#]+$/.exec(options.endpoint)?.[1];
    const local = authority !== undefined && /^(127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(authority);
    if (
      !authority ||
      authority.includes("@") ||
      endpoint.username ||
      endpoint.password ||
      options.endpoint.includes("?") ||
      options.endpoint.includes("#") ||
      (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && local))
    ) {
      throw new Error("TELEMETRY_CONFIG_INVALID");
    }
    // Headers trims boundary whitespace, so reject CR/LF before normalization.
    if (options.bearerToken !== undefined && /[\r\n]/.test(options.bearerToken)) {
      throw new Error("TELEMETRY_CONFIG_INVALID");
    }
    const headers = new Headers({ "Content-Type": "application/json" });
    if (options.bearerToken !== undefined) headers.set("Authorization", `Bearer ${options.bearerToken}`);
    return { endpoint, headers };
  } catch {
    throw new Error("TELEMETRY_CONFIG_INVALID");
  }
}
