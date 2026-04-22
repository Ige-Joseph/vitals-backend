import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { jwtUtil } from '@/lib/jwt';
import { env } from '@/config/env';
import { authRepository } from './auth.repository';
import { outboxRepository } from '@/modules/outbox/outbox.repository';
import { createLogger } from '@/lib/logger';
import type { PrismaTx } from '@/types/prisma';

const log = createLogger('auth-service');

const BCRYPT_ROUNDS = 12;

const hashToken = (raw: string): string =>
  crypto.createHash('sha256').update(raw).digest('hex');

const generateOpaqueToken = (): string => crypto.randomBytes(48).toString('hex');

const getRefreshTokenExpiryDate = (): Date => {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  return expiresAt;
};

const issueTokenPair = async (
  user: {
    id: string;
    email: string;
    role: string;
    emailVerified: boolean;
    planType: string;
  },
  tx?: PrismaTx,
) => {
  const rawRefreshToken = generateOpaqueToken();
  const refreshTokenHash = hashToken(rawRefreshToken);
  const refreshExpiresAt = getRefreshTokenExpiryDate();

  await authRepository.createRefreshToken(
    {
      userId: user.id,
      tokenHash: refreshTokenHash,
      expiresAt: refreshExpiresAt,
    },
    tx,
  );

  const accessToken = jwtUtil.signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    emailVerified: user.emailVerified,
    planType: user.planType,
  });

  return {
    accessToken,
    refreshToken: rawRefreshToken,
  };
};

export const authService = {
  async signup(data: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
    gender?: string;
    country?: string;
  }) {
    const existing = await authRepository.findUserByEmail(data.email);
    if (existing) {
      throw AppError.conflict('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);

    const rawVerificationToken = uuidv4();
    const verificationTokenHash = hashToken(rawVerificationToken);

    const verificationExpiresAt = new Date();
    verificationExpiresAt.setHours(
      verificationExpiresAt.getHours() + env.EMAIL_VERIFICATION_TOKEN_EXPIRES_HOURS,
    );

    const result = await prisma.$transaction(async (tx: PrismaTx) => {
      const user = await authRepository.createUser(
        {
          email: data.email,
          passwordHash,
          firstName: data.firstName,
          lastName: data.lastName,
        },
        tx,
      );

      if (data.gender || data.country) {
        await tx.profile.create({
          data: {
            userId: user.id,
            ...(data.gender ? { gender: data.gender as any } : {}),
            ...(data.country ? { country: data.country } : {}),
          },
        });
      }

      await authRepository.createVerificationToken(
        {
          userId: user.id,
          tokenHash: verificationTokenHash,
          expiresAt: verificationExpiresAt,
        },
        tx,
      );

      await outboxRepository.create(
        {
          userId: user.id,
          type: 'EMAIL_VERIFICATION',
          payload: {
            userId: user.id,
            email: user.email,
            rawToken: rawVerificationToken,
          },
        },
        tx,
      );

      

      const tokens = await issueTokenPair(user, tx);

      return {
        user,
        tokens,
      };
    });

    log.info('User created', { userId: result.user.id });

    return {
      user: {
        id: result.user.id,
        email: result.user.email,
        firstName: result.user.firstName,
        lastName: result.user.lastName,
        role: result.user.role,
        planType: result.user.planType,
        emailVerified: result.user.emailVerified,
      },
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
    };
  },

  async login(data: { email: string; password: string }) {
    const user = await authRepository.findUserByEmail(data.email);

    const fallbackHash =
      '$2b$12$C6UzMDM.H6dfI/f/IKcEeO4Z7K8J0uIK4vbe6PfUu8R6G6VvM9a3W';

    const passwordHashToCompare = user?.passwordHash ?? fallbackHash;
    const isValid = await bcrypt.compare(data.password, passwordHashToCompare);

    if (!user || !isValid) {
      throw AppError.unauthorized('Invalid email or password');
    }

    if (!user.isActive) {
      throw AppError.forbidden('Your account has been deactivated. Please contact support.');
    }

    const tokens = await issueTokenPair(user);

    log.info('User logged in', { userId: user.id });

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        planType: user.planType,
        emailVerified: user.emailVerified,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  },

  async refresh(rawRefreshToken: string) {
    const tokenHash = hashToken(rawRefreshToken);
    const stored = await authRepository.findRefreshToken(tokenHash);

    if (!stored) {
      throw AppError.unauthorized('Invalid or expired refresh token');
    }

    if (stored.revokedAt || stored.expiresAt < new Date()) {
      if (stored.userId) {
        await authRepository.revokeAllUserRefreshTokens(stored.userId);
        log.warn('Refresh token reuse or expired token detected', {
          userId: stored.userId,
        });
      }

      throw AppError.unauthorized('Invalid or expired refresh token');
    }

    const user = stored.user;

    if (!user.isActive) {
      throw AppError.forbidden('Account is deactivated');
    }

    const result = await prisma.$transaction(async (tx: PrismaTx) => {
      await authRepository.revokeRefreshToken(tokenHash, tx);

      const tokens = await issueTokenPair(user, tx);

      return tokens;
    });

    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  },

  async verifyEmail(rawToken: string) {
    const tokenHash = hashToken(rawToken);
    const record = await authRepository.findVerificationToken(tokenHash);

    if (!record) {
      throw AppError.badRequest('This verification link is invalid or has expired');
    }

    if (record.usedAt) {
      return { alreadyVerified: true };
    }

    if (record.expiresAt < new Date()) {
      throw AppError.badRequest('This verification link has expired. Please request a new one');
    }

    await prisma.$transaction(async (tx: PrismaTx) => {
      await authRepository.markVerificationTokenUsed(record.id, tx);
      await authRepository.markEmailVerified(record.userId, tx);
    });

    log.info('Email verified', { userId: record.userId });

    return { alreadyVerified: false };
  },

  async resendVerification(userId: string) {
    const user = await authRepository.findUserById(userId);

    if (!user) {
      throw AppError.notFound('User not found');
    }

    if (user.emailVerified) {
      throw AppError.conflict('Email is already verified');
    }

    const rawToken = uuidv4();
    const tokenHash = hashToken(rawToken);

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + env.EMAIL_VERIFICATION_TOKEN_EXPIRES_HOURS);

    await prisma.$transaction(async (tx: PrismaTx) => {
      await authRepository.invalidatePreviousVerificationTokens(user.id, tx);

      await authRepository.createVerificationToken(
        {
          userId: user.id,
          tokenHash,
          expiresAt,
        },
        tx,
      );

      await outboxRepository.create(
        {
          userId: user.id,
          type: 'EMAIL_VERIFICATION',
          payload: {
            userId: user.id,
            email: user.email,
            rawToken,
          },
        },
        tx,
      );
    });

    log.info('Verification email resent', { userId: user.id });
  },

  async logout(rawRefreshToken: string) {
    const tokenHash = hashToken(rawRefreshToken);

    const stored = await authRepository.findRefreshToken(tokenHash);
    if (!stored) {
      return;
    }

    if (!stored.revokedAt) {
      await authRepository.revokeRefreshToken(tokenHash);
    }
  },



    async forgotPassword(email: string) {
    const user = await authRepository.findUserByEmail(email);

    // Do not reveal whether the email exists
    if (!user) {
      log.info('Password reset requested for non-existent email', { email });
      return;
    }

    if (!user.isActive) {
      log.info('Password reset requested for deactivated account', { userId: user.id });
      return;
    }

    const rawToken = uuidv4();
    const tokenHash = hashToken(rawToken);

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + env.PASSWORD_RESET_TOKEN_EXPIRES_HOURS);

    await prisma.$transaction(async (tx: PrismaTx) => {
      await authRepository.invalidatePreviousPasswordResetTokens(user.id, tx);

      await authRepository.createPasswordResetToken(
        {
          userId: user.id,
          tokenHash,
          expiresAt,
        },
        tx,
      );

      await outboxRepository.create(
        {
          userId: user.id,
          type: 'PASSWORD_RESET',
          payload: {
            userId: user.id,
            email: user.email,
            rawToken,
          },
        },
        tx,
      );
    });

    log.info('Password reset email queued', { userId: user.id });
  },

  async resetPassword(rawToken: string, newPassword: string) {
    const tokenHash = hashToken(rawToken);
    const record = await authRepository.findPasswordResetToken(tokenHash);

    if (!record) {
      throw AppError.badRequest('This password reset link is invalid or has expired');
    }

    if (record.usedAt) {
      throw AppError.badRequest('This password reset link has already been used');
    }

    if (record.expiresAt < new Date()) {
      throw AppError.badRequest('This password reset link has expired. Please request a new one');
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await prisma.$transaction(async (tx: PrismaTx) => {
      await authRepository.markPasswordResetTokenUsed(record.id, tx);
      await authRepository.updatePasswordHash(record.userId, passwordHash, tx);
      await authRepository.revokeAllUserRefreshTokens(record.userId, tx);
    });

    log.info('Password reset completed', { userId: record.userId });
  },



    async getCurrentUser(userId: string) {
    const user = await authRepository.findUserById(userId);
    if (!user) {
      throw AppError.notFound('User not found');
    }

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      planType: user.planType,
      emailVerified: user.emailVerified,
    };
  },
};


