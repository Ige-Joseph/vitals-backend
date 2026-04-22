import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const authRepository = {
  // ─── User ───────────────────────────────────────────────────────────
  findUserByEmail(email: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.user.findUnique({
      where: { email: email.toLowerCase() },
    });
  },

  findUserById(id: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.user.findUnique({
      where: { id },
    });
  },

  createUser(
    data: {
      email: string;
      passwordHash: string;
      firstName?: string;
      lastName?: string;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? prisma;
    return client.user.create({
      data: {
        email: data.email.toLowerCase(),
        passwordHash: data.passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
      },
    });
  },

  markEmailVerified(userId: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.user.update({
      where: { id: userId },
      data: { emailVerified: true },
    });
  },

  updatePasswordHash(userId: string, passwordHash: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
  },

  // ─── Refresh tokens ─────────────────────────────────────────────────
  createRefreshToken(
    data: { userId: string; tokenHash: string; expiresAt: Date },
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? prisma;
    return client.refreshToken.create({ data });
  },

  findRefreshToken(tokenHash: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
  },

  revokeRefreshToken(tokenHash: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.refreshToken.update({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    });
  },

  revokeAllUserRefreshTokens(userId: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  // ─── Verification tokens ────────────────────────────────────────────
  createVerificationToken(
    data: { userId: string; tokenHash: string; expiresAt: Date },
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? prisma;
    return client.emailVerificationToken.create({ data });
  },

  findVerificationToken(tokenHash: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.emailVerificationToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
  },

  markVerificationTokenUsed(id: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.emailVerificationToken.update({
      where: { id },
      data: { usedAt: new Date() },
    });
  },

  invalidatePreviousVerificationTokens(userId: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.emailVerificationToken.updateMany({
      where: {
        userId,
        usedAt: null,
      },
      data: { usedAt: new Date() },
    });
  },

  // ─── Password reset tokens ───────────────────────────────────────────
  createPasswordResetToken(
    data: { userId: string; tokenHash: string; expiresAt: Date },
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? prisma;
    return client.passwordResetToken.create({ data });
  },

  findPasswordResetToken(tokenHash: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
  },

  markPasswordResetTokenUsed(id: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.passwordResetToken.update({
      where: { id },
      data: { usedAt: new Date() },
    });
  },

  invalidatePreviousPasswordResetTokens(userId: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.passwordResetToken.updateMany({
      where: {
        userId,
        usedAt: null,
      },
      data: { usedAt: new Date() },
    });
  },
};