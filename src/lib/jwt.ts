import jwt from 'jsonwebtoken';
import { env } from '@/config/env';

export interface AccessTokenPayload {
  sub: string;         // userId
  email: string;
  role: string;
  emailVerified: boolean;
  planType: string;
}

export interface RefreshTokenPayload {
  sub: string;         // userId
  jti: string;         // token family ID — used to find the DB record
}

export const jwtUtil = {
  signAccessToken(payload: AccessTokenPayload): string {
    return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
      expiresIn: env.JWT_ACCESS_EXPIRES_IN as any,
    });
  },

  signRefreshToken(payload: RefreshTokenPayload): string {
    return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
      expiresIn: env.JWT_REFRESH_EXPIRES_IN as any,
    });
  },

  verifyAccessToken(token: string): AccessTokenPayload {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
  },

  verifyRefreshToken(token: string): RefreshTokenPayload {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
  },

  generateOAuthStateToken(userId: string): string {
    return jwt.sign(
      {
        sub: userId,
        type: 'GOOGLE_CALENDAR_CONNECT',
      },
      env.JWT_ACCESS_SECRET,
      {
        expiresIn: '10m',
      },
    );
  },

  verifyOAuthStateToken(token: string): {
    sub: string;
    type: string;
  } {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as {
      sub: string;
      type: string;
    };
  },

  /**
   * State for the Google *sign-in* round trip.
   *
   * Deliberately a different function from the calendar one above rather than
   * a parameter on it, because the two carry different things and confusing
   * them would be a security bug rather than a tidiness problem:
   *
   *   calendar  { sub: userId, type: GOOGLE_CALENDAR_CONNECT }
   *   sign-in   { nonce,       type: GOOGLE_SIGN_IN          }
   *
   * Sign-in has no `sub` because there is no user yet — that is the whole
   * point of the flow. What it carries instead is a nonce, matched against an
   * HttpOnly cookie set when the round trip began. The signature proves we
   * minted the state; the nonce proves it was minted for *this browser*, which
   * is what stops an attacker completing a login into their own Google account
   * in someone else's session.
   *
   * The `type` discriminator is checked on both sides, so a calendar state can
   * never be replayed at the sign-in callback or the reverse.
   */
  signGoogleSignInState(nonce: string): string {
    return jwt.sign(
      { nonce, type: 'GOOGLE_SIGN_IN' },
      env.JWT_ACCESS_SECRET,
      { expiresIn: '10m' },
    );
  },

  verifyGoogleSignInState(token: string): { nonce: string; type: string } {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as {
      nonce: string;
      type: string;
    };
  },
};
