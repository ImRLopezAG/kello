/** Safe failures shared by Promise and Effect rate-limit capabilities. */
export class RateLimitExceeded extends Error {
  readonly _tag = "RateLimitExceeded";
  constructor(readonly retryAfterMs: number) {
    super("Rate limit exceeded");
    this.name = "RateLimitExceeded";
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1 || retryAfterMs > 86_400_000)
      throw new RangeError("Invalid rate-limit retry duration");
  }
}

export class RateLimitUnavailable extends Error {
  readonly _tag = "RateLimitUnavailable";
  constructor() {
    super("Rate limit unavailable");
    this.name = "RateLimitUnavailable";
  }
}
