export interface RateLimitResult {
  allowed: boolean;
  /** Whole seconds until the window resets. Meaningful when `allowed` is false. */
  retryAfterSeconds: number;
}

/**
 * Counts hits per key. Behind an interface so a shared store (Redis) can replace the in-process
 * one when there is a second API instance: the limit would otherwise be per instance.
 */
export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

/** Fixed windows held in memory. Expired windows are dropped as new ones are opened. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private sweptAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = this.now();
    this.sweep(now);
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    window.count++;
    return {
      allowed: window.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    };
  }

  /** Keeps the map bounded: at most once a minute, remove windows that have ended. */
  private sweep(now: number): void {
    if (now - this.sweptAt < 60_000) return;
    this.sweptAt = now;
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}
