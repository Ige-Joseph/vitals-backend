import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '@/lib/errors';
import { sendError } from '@/lib/response';
import { createLogger } from '@/lib/logger';

const log = createLogger('error-handler');

export const globalErrorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  // Known, operational AppError
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      log.error('Operational error', {
        message: err.message,
        statusCode: err.statusCode,
        path: req.path,
        method: req.method,
        stack: err.stack,
      });
    } else {
      log.warn('Client error', {
        message: err.message,
        statusCode: err.statusCode,
        path: req.path,
      });
    }

    sendError(res, err.message, err.errorCode, err.statusCode);
    return;
  }

  // Zod validation error — shouldn't reach here if using safeParse, but just in case
  if (err instanceof ZodError) {
    const message = err.issues[0]?.message ?? 'Validation failed';
    sendError(res, message, 'VALIDATION_ERROR', 422);
    return;
  }

  // Prisma known errors
  if ((err as any).code === 'P2002') {
    sendError(res, 'A record with this value already exists', 'CONFLICT', 409);
    return;
  }

  if ((err as any).code === 'P2025') {
    sendError(res, 'Record not found', 'NOT_FOUND', 404);
    return;
  }

  // Unknown / unexpected errors — always log with full context
  log.error('Unexpected error', {
    message: err.message,
    path: req.path,
    method: req.method,
    stack: err.stack,
  });

  sendError(res, 'An unexpected error occurred', 'INTERNAL_ERROR', 500);
};

// Catch-all for 404 routes
export const notFoundHandler = (req: Request, res: Response): void => {
  sendError(res, `Route ${req.method} ${req.path} not found`, 'NOT_FOUND', 404);
};
