import { authService } from '@/modules/auth/auth.service';
import { authRepository } from '@/modules/auth/auth.repository';
import { outboxRepository } from '@/modules/outbox/outbox.repository';
import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import bcrypt from 'bcryptjs';

// Mock all external dependencies
jest.mock('@/modules/auth/auth.repository');
jest.mock('@/modules/outbox/outbox.repository');
jest.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: jest.fn(),
    user: { update: jest.fn() },
  },
}));

const mockAuthRepo = authRepository as jest.Mocked<typeof authRepository>;
const mockOutboxRepo = outboxRepository as jest.Mocked<typeof outboxRepository>;
const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const mockUser = {
  id: 'user-123',
  email: 'test@example.com',
  passwordHash: '$2a$12$hashedpassword',
  role: 'USER' as const,
  planType: 'FREE' as const,
  emailVerified: false,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('AuthService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── signup ──────────────────────────────────────────────────────────
  describe('signup', () => {
    it('throws conflict if email already exists', async () => {
      mockAuthRepo.findUserByEmail.mockResolvedValue(mockUser);

      await expect(
        authService.signup({ email: 'test@example.com', password: 'Password1' }),
      ).rejects.toThrow(AppError);

      await expect(
        authService.signup({ email: 'test@example.com', password: 'Password1' }),
      ).rejects.toMatchObject({ errorCode: 'CONFLICT' });
    });

    it('creates user, verification token, and outbox event atomically', async () => {
      mockAuthRepo.findUserByEmail.mockResolvedValue(null);

      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) => {
        return fn({
          user: { create: jest.fn().mockResolvedValue(mockUser) },
          emailVerificationToken: { create: jest.fn() },
          outboxEvent: { create: jest.fn() },
        });
      });

      mockAuthRepo.createRefreshToken.mockResolvedValue({} as any);

      const result = await authService.signup({
        email: 'new@example.com',
        password: 'Password1',
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result.user.emailVerified).toBe(false);
    });
  });

  // ─── login ───────────────────────────────────────────────────────────
  describe('login', () => {
    it('throws unauthorized for non-existent email', async () => {
      mockAuthRepo.findUserByEmail.mockResolvedValue(null);

      await expect(
        authService.login({ email: 'nobody@example.com', password: 'Password1' }),
      ).rejects.toMatchObject({ errorCode: 'UNAUTHORIZED' });
    });

    it('throws unauthorized for wrong password', async () => {
      const userWithHash = {
        ...mockUser,
        passwordHash: await bcrypt.hash('CorrectPassword1', 12),
      };
      mockAuthRepo.findUserByEmail.mockResolvedValue(userWithHash);

      await expect(
        authService.login({ email: 'test@example.com', password: 'WrongPassword1' }),
      ).rejects.toMatchObject({ errorCode: 'UNAUTHORIZED' });
    });

    it('throws forbidden for deactivated account', async () => {
      const deactivatedUser = {
        ...mockUser,
        isActive: false,
        passwordHash: await bcrypt.hash('Password1', 12),
      };
      mockAuthRepo.findUserByEmail.mockResolvedValue(deactivatedUser);

      await expect(
        authService.login({ email: 'test@example.com', password: 'Password1' }),
      ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
    });

    it('returns tokens for valid credentials', async () => {
      const hash = await bcrypt.hash('Password1', 12);
      mockAuthRepo.findUserByEmail.mockResolvedValue({ ...mockUser, passwordHash: hash });
      mockAuthRepo.createRefreshToken.mockResolvedValue({} as any);

      const result = await authService.login({
        email: 'test@example.com',
        password: 'Password1',
      });

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.user.id).toBe('user-123');
    });
  });

  // ─── verifyEmail ─────────────────────────────────────────────────────
  describe('verifyEmail', () => {
    it('throws bad request for unknown token', async () => {
      mockAuthRepo.findVerificationToken.mockResolvedValue(null);

      await expect(authService.verifyEmail('invalid-token')).rejects.toMatchObject({
        errorCode: 'BAD_REQUEST',
      });
    });

    it('returns alreadyVerified=true for used token', async () => {
      mockAuthRepo.findVerificationToken.mockResolvedValue({
        id: 'token-1',
        userId: 'user-123',
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() + 86400000),
        usedAt: new Date(), // Already used
        createdAt: new Date(),
        user: mockUser,
      } as any);

      const result = await authService.verifyEmail('some-token');
      expect(result.alreadyVerified).toBe(true);
    });

    it('throws bad request for expired token', async () => {
      mockAuthRepo.findVerificationToken.mockResolvedValue({
        id: 'token-1',
        userId: 'user-123',
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() - 1000), // Expired
        usedAt: null,
        createdAt: new Date(),
        user: mockUser,
      } as any);

      await expect(authService.verifyEmail('expired-token')).rejects.toMatchObject({
        errorCode: 'BAD_REQUEST',
      });
    });

    it('marks token used and user verified for valid token', async () => {
      mockAuthRepo.findVerificationToken.mockResolvedValue({
        id: 'token-1',
        userId: 'user-123',
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() + 86400000), // Valid
        usedAt: null,
        createdAt: new Date(),
        user: mockUser,
      } as any);

      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) => fn({}));
      mockAuthRepo.markVerificationTokenUsed.mockResolvedValue({} as any);
      mockAuthRepo.markEmailVerified.mockResolvedValue({} as any);

      const result = await authService.verifyEmail('valid-token');
      expect(result.alreadyVerified).toBe(false);
    });
  });
});
