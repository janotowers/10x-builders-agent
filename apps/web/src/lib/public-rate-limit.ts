type Bucket = { timestamps: number[] };

const buckets = new Map<string, Bucket>();

export function rateLimit(
  key: string,
  max: number,
  windowMs: number
): { ok: true } | { ok: false; retryAfterMs: number } {
  const now = Date.now();
  const b = buckets.get(key) ?? { timestamps: [] };
  const cutoff = now - windowMs;
  b.timestamps = b.timestamps.filter((t) => t > cutoff);
  if (b.timestamps.length >= max) {
    const oldest = b.timestamps[0] ?? now;
    buckets.set(key, b);
    return { ok: false, retryAfterMs: windowMs - (now - oldest) };
  }
  b.timestamps.push(now);
  buckets.set(key, b);
  return { ok: true };
}
