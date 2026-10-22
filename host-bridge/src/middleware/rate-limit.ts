import type { Request, Response, NextFunction } from 'express';

interface RateBucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateBucket>();

/**
 * Simple per-endpoint-group rate limiter.
 * @param maxPerMinute Max requests per minute for this group.
 */
export function rateLimitMiddleware(maxPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Group key is the first path segment (pm2, pty, script)
    const group = req.baseUrl.split('/')[1] || 'default';
    const now = Date.now();

    let bucket = buckets.get(group);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + 60_000 };
      buckets.set(group, bucket);
    }

    bucket.count++;

    if (bucket.count > maxPerMinute) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        success: false,
        error: `Rate limit exceeded for ${group} (${maxPerMinute}/min)`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    next();
  };
}
