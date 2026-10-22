import type { Request, Response, NextFunction } from 'express';

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
    if (provided !== token) {
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
