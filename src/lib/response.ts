import { Response } from 'express';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'QUOTA_EXCEEDED'
  | 'DUPLICATE_REQUEST'
  | 'CONFLICT'
  | 'INTERNAL_ERROR'
  | 'BAD_REQUEST';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T | null;
  message: string;
  errorCode: ErrorCode | null;
}

export const sendSuccess = <T>(
  res: Response,
  data: T,
  message: string,
  statusCode = 200,
): Response => {
  const body: ApiResponse<T> = {
    success: true,
    data,
    message,
    errorCode: null,
  };
  return res.status(statusCode).json(body);
};

export const sendError = (
  res: Response,
  message: string,
  errorCode: ErrorCode,
  statusCode: number,
): Response => {
  const body: ApiResponse<null> = {
    success: false,
    data: null,
    message,
    errorCode,
  };
  return res.status(statusCode).json(body);
};

// Named HTTP shortcuts
export const ok = <T>(res: Response, data: T, message = 'Success') =>
  sendSuccess(res, data, message, 200);

export const created = <T>(res: Response, data: T, message = 'Created successfully') =>
  sendSuccess(res, data, message, 201);

export const badRequest = (res: Response, message: string) =>
  sendError(res, message, 'BAD_REQUEST', 400);

export const unauthorized = (res: Response, message = 'Unauthorized') =>
  sendError(res, message, 'UNAUTHORIZED', 401);

export const forbidden = (res: Response, message = 'Forbidden') =>
  sendError(res, message, 'FORBIDDEN', 403);

export const notFound = (res: Response, message = 'Resource not found') =>
  sendError(res, message, 'NOT_FOUND', 404);

export const conflict = (res: Response, message: string) =>
  sendError(res, message, 'CONFLICT', 409);

export const validationError = (res: Response, message: string) =>
  sendError(res, message, 'VALIDATION_ERROR', 422);

export const quotaExceeded = (res: Response, message = 'Daily quota exceeded') =>
  sendError(res, message, 'QUOTA_EXCEEDED', 429);

export const internalError = (res: Response, message = 'Internal server error') =>
  sendError(res, message, 'INTERNAL_ERROR', 500);
