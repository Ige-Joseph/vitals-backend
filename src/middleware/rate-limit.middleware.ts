import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { sendError } from '@/lib/response';

// Global rate limiter — applied to all routes
export const globalRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    sendError(res, 'Too many requests. Please try again later.', 'BAD_REQUEST', 429);
  },
});

// Stricter limiter for auth endpoints — prevents brute force
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    sendError(
      res,
      'Too many authentication attempts. Please try again in 15 minutes.',
      'BAD_REQUEST',
      429,
    );
  },
});
