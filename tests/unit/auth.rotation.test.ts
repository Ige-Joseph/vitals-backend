import crypto from 'crypto';
import { authService } from '@/modules/auth/auth.service';
import { authRepository } from '@/modules/auth/auth.repository';
import { prisma } from '@/lib/prisma';

jest.mock('@/modules/auth/auth.repository');
jest.mock('@/lib/prisma', () => ({ prisma: { $transaction: jest.fn() } }));
jest.mock('@/lib/jwt', () => ({
  jwtUtil: { signAccessToken: jest.fn(() => 'access-token') },
}));
jest.mock('@/providers/email/email.service', () => ({ emailService: {} }));
jest.mock('@/modules/outbox/outbox.repository', () => ({ outboxRepository: {} }));

const hash = (raw: string): string =>
  crypto.createHash('sha256').update(raw).digest('hex');

const mockRepo = authRepository as jest.Mocked<typeof authRepository>;
const mockPrisma = prisma as unknown as { $transaction: jest.Mock };
// findRefreshToken returns Prisma's thenable client type, not a plain Promise.
const findRefreshToken = authRepository.findRefreshToken as unknown as jest.Mock;

const user = {
  id: 'user-1',
  email: 'user@example.com',
  firstName: 'Ada',
  lastName: 'Obi',
  role: 'USER',
  planType: 'FREE',
  emailVerified: true,
  isActive: true,
};

const tokenRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'token-id',
  userId: user.id,
  tokenHash: 'hash',
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  revokedAt: null,
  createdAt: new Date(),
  replacedByTokenHash: null,
  user,
  ...overrides,
});

const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
  mockRepo.createRefreshToken.mockResolvedValue({} as never);
  mockRepo.revokeRefreshToken.mockResolvedValue({} as never);
  mockRepo.revokeAllUserRefreshTokens.mockResolvedValue({ count: 1 } as never);
});

describe('Refresh token rotation', () => {
  it('rotates a live token and records what replaced it', async () => {
    const raw = 'current-token';
    findRefreshToken.mockResolvedValue(
      tokenRecord({ tokenHash: hash(raw) }) as never,
    );

    const result = await authService.refresh(raw);

    expect(result.accessToken).toBe('access-token');
    expect(mockRepo.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    expect(mockRepo.revokeRefreshToken).toHaveBeenCalledWith(
      hash(raw),
      expect.anything(),
      expect.any(String),
    );
  });

  describe('concurrent refresh from a second browser tab', () => {
    it('resolves a token rotated moments ago instead of revoking the session', async () => {
      const rawOld = 'rotated-token';
      const rawLive = 'replacement-token';

      findRefreshToken.mockImplementation(async (tokenHash: string) => {
        if (tokenHash === hash(rawOld)) {
          return tokenRecord({
            tokenHash: hash(rawOld),
            revokedAt: secondsAgo(5),
            replacedByTokenHash: hash(rawLive),
          }) as never;
        }
        if (tokenHash === hash(rawLive)) {
          return tokenRecord({ tokenHash: hash(rawLive) }) as never;
        }
        return null as never;
      });

      const result = await authService.refresh(rawOld);

      expect(result.accessToken).toBe('access-token');
      expect(mockRepo.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
      // Rotation continues from the live replacement, not the stale token.
      expect(mockRepo.revokeRefreshToken).toHaveBeenCalledWith(
        hash(rawLive),
        expect.anything(),
        expect.any(String),
      );
    });

    it('resolves a chain of several tabs racing at once', async () => {
      const [rawOld, rawMiddle, rawLive] = ['tab-a', 'tab-b', 'tab-c'];

      findRefreshToken.mockImplementation(async (tokenHash: string) => {
        if (tokenHash === hash(rawOld)) {
          return tokenRecord({
            tokenHash: hash(rawOld),
            revokedAt: secondsAgo(3),
            replacedByTokenHash: hash(rawMiddle),
          }) as never;
        }
        if (tokenHash === hash(rawMiddle)) {
          return tokenRecord({
            tokenHash: hash(rawMiddle),
            revokedAt: secondsAgo(1),
            replacedByTokenHash: hash(rawLive),
          }) as never;
        }
        if (tokenHash === hash(rawLive)) {
          return tokenRecord({ tokenHash: hash(rawLive) }) as never;
        }
        return null as never;
      });

      await expect(authService.refresh(rawOld)).resolves.toMatchObject({
        accessToken: 'access-token',
      });
      expect(mockRepo.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    });
  });

  describe('genuine token reuse', () => {
    it('revokes every session when the token was rotated outside the grace window', async () => {
      const rawOld = 'stolen-token';
      const rawLive = 'replacement-token';

      findRefreshToken.mockImplementation(async (tokenHash: string) => {
        if (tokenHash === hash(rawOld)) {
          return tokenRecord({
            tokenHash: hash(rawOld),
            revokedAt: secondsAgo(60),
            replacedByTokenHash: hash(rawLive),
          }) as never;
        }
        return tokenRecord({ tokenHash: hash(rawLive) }) as never;
      });

      await expect(authService.refresh(rawOld)).rejects.toThrow(
        'Invalid or expired refresh token',
      );
      expect(mockRepo.revokeAllUserRefreshTokens).toHaveBeenCalledWith(user.id);
    });

    it('revokes every session when the replacement chain is already dead', async () => {
      const rawOld = 'stolen-token';
      const rawDead = 'dead-replacement';

      findRefreshToken.mockImplementation(async (tokenHash: string) => {
        if (tokenHash === hash(rawOld)) {
          return tokenRecord({
            tokenHash: hash(rawOld),
            revokedAt: secondsAgo(2),
            replacedByTokenHash: hash(rawDead),
          }) as never;
        }
        return tokenRecord({
          tokenHash: hash(rawDead),
          revokedAt: secondsAgo(600),
        }) as never;
      });

      await expect(authService.refresh(rawOld)).rejects.toThrow(
        'Invalid or expired refresh token',
      );
      expect(mockRepo.revokeAllUserRefreshTokens).toHaveBeenCalledWith(user.id);
    });

    it('revokes every session for a revoked token that never recorded a replacement', async () => {
      const rawOld = 'legacy-revoked-token';

      findRefreshToken.mockResolvedValue(
        tokenRecord({
          tokenHash: hash(rawOld),
          revokedAt: secondsAgo(2),
          replacedByTokenHash: null,
        }) as never,
      );

      await expect(authService.refresh(rawOld)).rejects.toThrow(
        'Invalid or expired refresh token',
      );
      expect(mockRepo.revokeAllUserRefreshTokens).toHaveBeenCalledWith(user.id);
    });

    it('refuses a replacement chain that points at another user and rotates nothing', async () => {
      const rawOld = 'rotated-token';
      const rawForeign = 'another-users-token';

      findRefreshToken.mockImplementation(async (tokenHash: string) => {
        if (tokenHash === hash(rawOld)) {
          return tokenRecord({
            tokenHash: hash(rawOld),
            revokedAt: secondsAgo(2),
            replacedByTokenHash: hash(rawForeign),
          }) as never;
        }
        return tokenRecord({
          tokenHash: hash(rawForeign),
          userId: 'user-2',
          user: { ...user, id: 'user-2' },
        }) as never;
      });

      await expect(authService.refresh(rawOld)).rejects.toThrow(
        'Invalid or expired refresh token',
      );
      expect(mockRepo.revokeAllUserRefreshTokens).toHaveBeenCalledWith(user.id);
      // The other user's live token must not be rotated or revoked.
      expect(mockRepo.revokeRefreshToken).not.toHaveBeenCalled();
    });
  });
});
