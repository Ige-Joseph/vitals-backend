import { Request, Response, NextFunction } from 'express';
import { authService } from './auth.service';
import {
  signupSchema,
  loginSchema,
  refreshSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from './auth.validators';
import { created, ok, validationError } from '@/lib/response';
import { AuthenticatedRequest } from '@/types/express';
import {
  assertTrustedCookieAuthOrigin,
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
  usesCookieAuthTransport,
} from './auth.cookies';

const exposeAuthResult = <T extends { refreshToken: string }>(
  req: Request,
  res: Response,
  result: T,
): Omit<T, 'refreshToken'> | T => {
  if (!usesCookieAuthTransport(req)) return result;

  setRefreshCookie(res, result.refreshToken);
  const { refreshToken: _refreshToken, ...safeResult } = result;
  return safeResult;
};

export const authController = {
  async signup(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = signupSchema.safeParse(req.body);
      if (!parsed.success) {
        return validationError(res, parsed.error.issues[0].message);
      }

      assertTrustedCookieAuthOrigin(req);
      const result = await authService.signup(parsed.data);
      return created(res, exposeAuthResult(req, res, result), 'Account created successfully');
    } catch (err) {
      next(err);
    }
  },

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return validationError(res, parsed.error.issues[0].message);
      }

      assertTrustedCookieAuthOrigin(req);
      const result = await authService.login(parsed.data);
      return ok(res, exposeAuthResult(req, res, result), 'Login successful');
    } catch (err) {
      next(err);
    }
  },

  async refresh(req: Request, res: Response, next: NextFunction) {
    try {
      assertTrustedCookieAuthOrigin(req);

      const parsed = refreshSchema.safeParse(req.body);
      const refreshToken = usesCookieAuthTransport(req)
        ? readRefreshCookie(req) ?? (parsed.success ? parsed.data.refreshToken : undefined)
        : parsed.success
          ? parsed.data.refreshToken
          : undefined;

      if (!refreshToken) {
        return validationError(res, 'Refresh token is required');
      }

      const result = await authService.refresh(refreshToken);
      return ok(res, exposeAuthResult(req, res, result), 'Tokens refreshed');
    } catch (err) {
      next(err);
    }
  },

  async verifyEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = verifyEmailSchema.safeParse(req.query);
      if (!parsed.success) {
        return validationError(res, 'Invalid or missing token');
      }

      const result = await authService.verifyEmail(parsed.data.token);
      const message = result.alreadyVerified
        ? 'Email already verified'
        : 'Email verified successfully';

      return ok(res, null, message);
    } catch (err) {
      next(err);
    }
  },

  async resendVerification(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      await authService.resendVerification(req.user!.sub);
      return ok(res, null, 'Verification email sent');
    } catch (err) {
      next(err);
    }
  },

  async forgotPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = forgotPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return validationError(res, parsed.error.issues[0].message);
      }

      await authService.forgotPassword(parsed.data.email);
      return ok(
        res,
        null,
        'If an account with that email exists, a password reset link has been sent',
      );
    } catch (err) {
      next(err);
    }
  },

  async resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = resetPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return validationError(res, parsed.error.issues[0].message);
      }

      await authService.resetPassword(parsed.data.token, parsed.data.password);
      return ok(res, null, 'Password reset successful');
    } catch (err) {
      next(err);
    }
  },

  async logout(req: Request, res: Response, next: NextFunction) {
    try {
      assertTrustedCookieAuthOrigin(req);
      const parsed = refreshSchema.safeParse(req.body);
      const refreshToken = usesCookieAuthTransport(req)
        ? readRefreshCookie(req) ?? (parsed.success ? parsed.data.refreshToken : undefined)
        : parsed.success
          ? parsed.data.refreshToken
          : undefined;

      if (refreshToken) {
        await authService.logout(refreshToken);
      }

      if (usesCookieAuthTransport(req)) clearRefreshCookie(res);
      return ok(res, null, 'Logged out successfully');
    } catch (err) {
      next(err);
    }
  },

  async me(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const user = await authService.getCurrentUser(req.user!.sub);
      return ok(res, user, 'Authenticated');
    } catch (err) {
      next(err);
    }
  },
};
