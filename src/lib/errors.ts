import { ErrorCode } from '@/lib/response';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: ErrorCode;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number,
    errorCode: ErrorCode,
    isOperational = true,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = isOperational;

    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this);
  }

  static badRequest(message: string) {
    return new AppError(message, 400, 'BAD_REQUEST');
  }

  static unauthorized(message = 'Unauthorized') {
    return new AppError(message, 401, 'UNAUTHORIZED');
  }

  static forbidden(message = 'Forbidden') {
    return new AppError(message, 403, 'FORBIDDEN');
  }

  static notFound(message = 'Resource not found') {
    return new AppError(message, 404, 'NOT_FOUND');
  }

  static conflict(message: string) {
    return new AppError(message, 409, 'CONFLICT');
  }

  /**
   * The thing existed and deliberately does not any more.
   *
   * Distinct from notFound on purpose: a client seeing 410 knows the request
   * was valid and that asking again for a fresh one will work, which is not
   * true of 404. Health summaries expire by design, and telling a reader
   * "not found" would read as an error rather than as the timer working.
   */
  static gone(message: string) {
    return new AppError(message, 410, 'GONE');
  }

  static validation(message: string) {
    return new AppError(message, 422, 'VALIDATION_ERROR');
  }

  static quotaExceeded(message = 'Daily quota exceeded') {
    return new AppError(message, 429, 'QUOTA_EXCEEDED');
  }

  static internal(message = 'Internal server error') {
    return new AppError(message, 500, 'INTERNAL_ERROR', false);
  }
}
