import { createHash, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/** Compare digests, so neither the content nor the length of the token shows in the timing. */
export function sameToken(provided: string, expected: string): boolean {
  return timingSafeEqual(createHash('sha256').update(provided).digest(), createHash('sha256').update(expected).digest());
}

export function authMiddleware(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!token) {
      res.status(401).json({
        success: false,
        error: 'Bridge has no auth token configured',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'Missing Authorization header',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const provided = authHeader.slice(7);
    if (!sameToken(provided, token)) {
      res.status(401).json({
        success: false,
        error: 'Invalid token',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    next();
  };
}
