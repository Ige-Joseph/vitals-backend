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
};
