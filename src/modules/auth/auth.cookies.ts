import type { CookieOptions, Request, Response } from 'express';
import { env } from '@/config/env';
import { AppError } from '@/lib/errors';

export const AUTH_TRANSPORT_HEADER = 'X-Auth-Transport';
export const AUTH_TRANSPORT_COOKIE = 'cookie';
export const REFRESH_COOKIE_NAME = 'vitals_refresh';

const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
  path: `${env.API_PREFIX}/auth`,
  maxAge: REFRESH_COOKIE_MAX_AGE_MS,
});

const allowedBrowserOrigins = (): Set<string> => {
  const configured = [
    ...env.CORS_ORIGIN.split(','),
    env.FRONTEND_URL,
  ];

  return new Set(
    configured.flatMap((value) => {
      const candidate = value.trim();
      if (!candidate || candidate === '*') return [];

      try {
        return [new URL(candidate).origin];
      } catch {
        return [];
      }
    }),
  );
};

export const usesCookieAuthTransport = (req: Request): boolean =>
  req.get(AUTH_TRANSPORT_HEADER)?.toLowerCase() === AUTH_TRANSPORT_COOKIE;

export const assertTrustedCookieAuthOrigin = (req: Request): void => {
  if (!usesCookieAuthTransport(req)) return;

  const origin = req.get('Origin');
  if (!origin || !allowedBrowserOrigins().has(origin)) {
    throw AppError.forbidden('Untrusted authentication request origin');
  }
};

const readCookie = (req: Request, name: string): string | undefined => {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;

  for (const entry of cookieHeader.split(';')) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex < 0) continue;

    if (entry.slice(0, separatorIndex).trim() !== name) continue;

    const value = entry.slice(separatorIndex + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }

  return undefined;
};

export const readRefreshCookie = (req: Request): string | undefined =>
  readCookie(req, REFRESH_COOKIE_NAME);

export const setRefreshCookie = (res: Response, refreshToken: string): void => {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, cookieOptions());
};

export const clearRefreshCookie = (res: Response): void => {
  const { maxAge: _maxAge, ...options } = cookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, options);
};

// ─────────────────────────────────────────────
// OAuth sign-in state
// ─────────────────────────────────────────────

export const OAUTH_STATE_COOKIE_NAME = 'vitals_oauth_state';

/** Matches the 10-minute life of the signed state token it is paired with. */
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * `sameSite: 'lax'` rather than the refresh cookie's `'none'`.
 *
 * Lax cookies *are* sent on top-level GET navigations, which is exactly and
 * only what Google's redirect back to us is. Anything stricter would drop the
 * cookie and break the flow; anything looser would attach it to cross-site
 * subrequests it has no business being on.
 */
const oauthStateCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: `${env.API_PREFIX}/auth/google`,
  maxAge: OAUTH_STATE_MAX_AGE_MS,
});

export const setOAuthStateCookie = (res: Response, nonce: string): void => {
  res.cookie(OAUTH_STATE_COOKIE_NAME, nonce, oauthStateCookieOptions());
};

export const readOAuthStateCookie = (req: Request): string | undefined =>
  readCookie(req, OAUTH_STATE_COOKIE_NAME);

/**
 * Cleared on every callback, success or failure. A state nonce is single-use:
 * leaving it live would let a captured callback URL be replayed.
 */
export const clearOAuthStateCookie = (res: Response): void => {
  const { maxAge: _maxAge, ...options } = oauthStateCookieOptions();
  res.clearCookie(OAUTH_STATE_COOKIE_NAME, options);
};

