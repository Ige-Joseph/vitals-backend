import type { NextFunction, Request, Response } from 'express';

import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('request-timing');
const SLOW_REQUEST_THRESHOLD_MS = 750;

/**
 * Records API response time without logging query strings, request bodies, or
 * user data. Normal request timings are visible in development; slow requests
 * are warnings in every environment.
 */
export const requestTimingMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!req.path.startsWith(env.API_PREFIX)) {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();

  res.once('finish', () => {
    const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
    const durationMs = Number(elapsedNanoseconds) / 1_000_000;
    const context = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
    };

    if (durationMs >= SLOW_REQUEST_THRESHOLD_MS) {
      log.warn('Slow API request', context);
      return;
    }

    log.debug('API request completed', context);
  });

  next();
};
