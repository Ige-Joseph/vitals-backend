import { Router, Request, Response, NextFunction } from 'express';
import { env } from '@/config/env';
import { ok } from '@/lib/response';
import { createLogger } from '@/lib/logger';
import { authRateLimiter } from '@/middleware/rate-limit.middleware';
import { googleAuthService } from './google-auth.service';
import {
  clearOAuthStateCookie,
  readOAuthStateCookie,
  setOAuthStateCookie,
  setRefreshCookie,
} from './auth.cookies';

const log = createLogger('google-auth-routes');
const router = Router();

/**
 * Google Sign-In.
 *
 * Mounted at /auth/google, and unauthenticated by design — this is how someone
 * without a session gets one. Distinct in every respect from
 * /calendar/google/*, which authorises calendar writes for a session that
 * already exists. Different scopes, different redirect URI, different state
 * type, different callback, no shared client.
 *
 * ── On age gating ───────────────────────────────────────────────────────
 *
 * The acceptance criteria require a date of birth and an under-16 prompt at
 * signup. The password signup schema collects neither today, so there is no
 * gate here to route Google through and none is added: gating only the
 * federated path would let the same person sign up unchecked by typing a
 * password, which is a worse safety story than the one that exists, and
 * building the gate into both paths is a change to password signup that this
 * task explicitly excludes. Reported rather than silently resolved.
 */

/**
 * @swagger
 * /auth/google:
 *   get:
 *     tags: [Auth]
 *     summary: Begin Google Sign-In
 *     description: |
 *       Returns the Google authorization URL for the client to navigate to, and
 *       sets a short-lived HttpOnly state cookie.
 *
 *       The cookie is half of the CSRF defence: the `state` parameter is a
 *       signed token carrying a nonce, and the callback only proceeds when the
 *       nonce in the state matches the one in the cookie. Without both, an
 *       attacker can complete a login into their own Google account inside
 *       someone else's browser.
 *     security: []
 *     responses:
 *       200:
 *         description: Authorization URL issued
 *       400:
 *         description: Google sign-in is not configured
 */
router.get(
  '/',
  authRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { url, nonce } = googleAuthService.start();
      setOAuthStateCookie(res, nonce);
      return ok(res, { url }, 'Google sign-in URL generated');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /auth/google/native:
 *   post:
 *     tags: [Auth]
 *     summary: Sign in with a native Google ID token
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idToken]
 *             properties:
 *               idToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Native Google sign-in successful
 *       409:
 *         description: Email already belongs to a password account
 */
router.post(
  '/native',
  authRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const idToken = typeof req.body?.idToken === 'string' ? req.body.idToken : '';
      const outcome = await googleAuthService.completeNativeSignIn(idToken);

      if (outcome.status === 'EMAIL_ALREADY_REGISTERED') {
        return res.status(409).json({
          success: false,
          data: { email: outcome.email },
          message: 'This email already has a Vitals password account. Sign in with your password.',
          errorCode: 'EMAIL_ALREADY_REGISTERED',
        });
      }

      return ok(res, outcome, 'Google sign-in successful');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /auth/google/callback:
 *   get:
 *     tags: [Auth]
 *     summary: Google Sign-In callback
 *     description: |
 *       Google redirects the browser here. Verifies the state nonce, exchanges
 *       the authorization code, verifies the ID token, resolves or creates the
 *       account, issues the ordinary Vitals session, and redirects into the
 *       app.
 *
 *       Always redirects — never renders JSON. A browser arriving from Google
 *       needs somewhere to land, including when it failed.
 *     security: []
 *     parameters:
 *       - in: query
 *         name: code
 *         schema: { type: string }
 *       - in: query
 *         name: state
 *         schema: { type: string }
 *     responses:
 *       302:
 *         description: Redirect into the application or back to login with an error
 */
router.get('/callback', async (req: Request, res: Response) => {
  const landing = (params: Record<string, string>) =>
    `${env.FRONTEND_URL}/auth/google?${new URLSearchParams(params).toString()}`;

  // Single-use, whatever happens next.
  const cookieNonce = readOAuthStateCookie(req);
  clearOAuthStateCookie(res);

  // Google reports a user who declined consent this way, and it is not an
  // error worth alarming anyone about.
  if (typeof req.query.error === 'string') {
    return res.redirect(landing({ status: 'cancelled' }));
  }

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';

  if (!code || !state) {
    return res.redirect(landing({ status: 'error', reason: 'missing_parameters' }));
  }

  try {
    const outcome = await googleAuthService.completeSignIn({
      code,
      state,
      cookieNonce,
    });

    if (outcome.status === 'EMAIL_ALREADY_REGISTERED') {
      return res.redirect(landing({ status: 'email_exists', email: outcome.email }));
    }

    // Set unconditionally rather than behind `usesCookieAuthTransport`. That
    // check reads a request header, and a top-level redirect from Google cannot
    // send one — there is no other transport available here, and the whole
    // point of the redirect is to hand the browser a session.
    //
    // The access token is deliberately *not* placed in the URL. A token in a
    // query string lands in history, in the Referer header and in any proxy
    // log between here and the user. The client calls /auth/refresh with this
    // cookie instead, which is the same path it already uses to restore a
    // session on load.
    setRefreshCookie(res, outcome.tokens.refreshToken);

    return res.redirect(
      landing({
        status: 'ok',
        profile: outcome.profileComplete ? 'complete' : 'incomplete',
        ...(outcome.created ? { created: '1' } : {}),
      }),
    );
  } catch (err: any) {
    // Never surface the internal reason to the browser: the distinctions here
    // ("bad state" versus "bad code") are exactly what a prober wants.
    log.warn('Google sign-in callback failed', { error: err?.message });
    return res.redirect(landing({ status: 'error', reason: 'sign_in_failed' }));
  }
});

export default router;
