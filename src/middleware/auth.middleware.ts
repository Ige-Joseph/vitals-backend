import { Response, NextFunction } from 'express';
import { jwtUtil } from '@/lib/jwt';
import { unauthorized, forbidden } from '@/lib/response';
import { AuthenticatedRequest } from '@/types/express';
import { createLogger } from '@/lib/logger';

const log = createLogger('auth-middleware');

/**
 * Verifies the Bearer token and attaches the decoded payload to req.user.
 * Rejects with 401 if the token is missing or invalid.
 */
export const authenticate = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    unauthorized(res, 'Authorization header missing or malformed');
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = jwtUtil.verifyAccessToken(token);
    req.user = payload;
    next();
  } catch (err: any) {
    log.debug('JWT verification failed', { error: err.message });
    unauthorized(res, 'Invalid or expired access token');
  }
};

/**
 * Middleware factory — restricts access to specific roles.
 * Must be used after `authenticate`.
 */
export const requireRole = (...roles: string[]) =>
  (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      unauthorized(res);
      return;
    }

    if (!roles.includes(req.user.role)) {
      forbidden(res, 'You do not have permission to access this resource');
      return;
    }

    next();
  };

// Convenience shorthands
export const requireAdmin = requireRole('ADMIN');
export const requireUser = requireRole('USER', 'ADMIN');

/**
 * Optional auth — attaches user if token is present and valid, but does not reject.
 * Useful for endpoints that behave differently for authenticated users.
 */
export const optionalAuth = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): void => {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      req.user = jwtUtil.verifyAccessToken(token);
    } catch {
      // Silent — optional auth does not reject
    }
  }

  next();
};
