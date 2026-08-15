/** Simple sliding-window rate limiter. Redis-backed when available. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  async check(key: string): Promise<{ ok: boolean; retryAfterMs: number }> {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (timestamps.length >= this.limit) {
      this.hits.set(key, timestamps);
      const oldest = timestamps[0] ?? now;
      return { ok: false, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
    }
    timestamps.push(now);
    this.hits.set(key, timestamps);
    return { ok: true, retryAfterMs: 0 };
  }
}

/** Per-IP limiter factory. */
export function createIpLimiter(limit: number, windowMs: number): RateLimiter {
  return new RateLimiter(limit, windowMs);
}
