import { ApiError } from "./http";

/**
 * Token-bucket limits held in process memory. Good enough to blunt abuse on a single node; a multi-node
 * deployment should put the same interface in front of a shared store (see docs/RUNBOOK.md).
 */
interface Bucket {
  tokens: number;
  updated: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 50_000;

export interface Limit {
  /** Bucket size. */
  burst: number;
  /** Tokens added per second. */
  perSecond: number;
}

export const LIMITS = {
  gatewayPerPayer: { burst: 30, perSecond: 5 },
  gatewayPerIp: { burst: 60, perSecond: 10 },
  authPerIp: { burst: 10, perSecond: 0.2 },
  apiPerActor: { burst: 60, perSecond: 2 },
  disputePerActor: { burst: 5, perSecond: 0.01 },
  publicReadPerIp: { burst: 120, perSecond: 20 },
} satisfies Record<string, Limit>;

export function take(key: string, limit: Limit, now = Date.now()): { ok: boolean; retryAfter: number } {
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_BUCKETS) prune(now);
    b = { tokens: limit.burst, updated: now };
    buckets.set(key, b);
  }
  b.tokens = Math.min(limit.burst, b.tokens + ((now - b.updated) / 1000) * limit.perSecond);
  b.updated = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true, retryAfter: 0 };
  }
  return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / limit.perSecond) };
}

export function enforce(key: string, limit: Limit): void {
  const r = take(key, limit);
  if (!r.ok) {
    throw new ApiError(429, "rate_limited", "Too many requests. Slow down and retry.", undefined, {
      "retry-after": String(r.retryAfter),
    });
  }
}

function prune(now: number) {
  for (const [key, b] of buckets) {
    if (now - b.updated > 10 * 60_000) buckets.delete(key);
  }
  if (buckets.size >= MAX_BUCKETS) buckets.clear();
}

export function resetRateLimitsForTesting(): void {
  buckets.clear();
}
