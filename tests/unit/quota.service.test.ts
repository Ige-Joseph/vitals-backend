import { quotaService } from '@/modules/usage/quota.service';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';

jest.mock('@/lib/prisma', () => ({
  prisma: {
    // The tier is read from the database now, not from the access token, so a
    // token minted before an upgrade cannot serve stale limits.
    user: { findUnique: jest.fn() },
    // Entitlement resolves from two independent facts: a paid subscription and
    // an admin grant. Neither is `User.planType`, which is a projection nothing
    // authorises against — so a premium account here is one with a grant, not
    // one with a column set.
    subscription: { findFirst: jest.fn().mockResolvedValue(null) },
    entitlementGrant: { findFirst: jest.fn().mockResolvedValue(null) },

    dailyUsage: {
      upsert: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
  },
}));

const mockUsage = (prisma as any).dailyUsage as {
  upsert: jest.Mock;
  updateMany: jest.Mock;
  findUnique: jest.Mock;
};

const prismaError = (code: string) => Object.assign(new Error(code), { code });

const mockUser = (prisma as any).user as { findUnique: jest.Mock };

/** Set the tier the database will report for the account under test. */
/**
 * Put the account on a tier the way the resolver actually reads one.
 *
 * PREMIUM means an active grant. Setting `planType` would no longer do
 * anything: the resolver does not read it, which is the point of the grant
 * model and worth the test exercising rather than working around.
 */
const onTier = (tier: 'FREE' | 'PREMIUM') => {
  mockUser.findUnique.mockResolvedValue({ planType: tier });
  (prisma as any).entitlementGrant.findFirst.mockResolvedValue(
    tier === 'PREMIUM' ? { id: 'grant-1', tier: 'PREMIUM', expiresAt: null } : null,
  );
};

describe('quotaService.checkAndIncrement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    onTier('FREE');
    mockUsage.upsert.mockResolvedValue({});
    mockUsage.updateMany.mockResolvedValue({ count: 1 });
  });

  it('claims one unit with a conditional update rather than read-then-write', async () => {
    await quotaService.checkAndIncrement('user-1', 'symptomCheck');

    expect(mockUsage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          symptomChecksUsed: { lt: env.FREE_SYMPTOM_CHECKS_PER_DAY },
        }),
        data: { symptomChecksUsed: { increment: 1 } },
      }),
    );
    // The old implementation read the count first; nothing should read it now.
    expect(mockUsage.findUnique).not.toHaveBeenCalled();
  });

  it('throws QUOTA_EXCEEDED when the conditional update matches no row', async () => {
    mockUsage.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      quotaService.checkAndIncrement('user-1', 'symptomCheck'),
    ).rejects.toMatchObject({ errorCode: 'QUOTA_EXCEEDED', statusCode: 429 });
  });

  it('uses the premium limit for premium users', async () => {
    onTier('PREMIUM');
    await quotaService.checkAndIncrement('user-1', 'drugDetection');

    expect(mockUsage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          drugDetectionsUsed: { lt: env.PREMIUM_DRUG_DETECTIONS_PER_DAY },
        }),
        data: { drugDetectionsUsed: { increment: 1 } },
      }),
    );
  });

  it('still claims when it loses the race to insert the day row', async () => {
    mockUsage.upsert.mockRejectedValue(prismaError('P2002'));

    await expect(
      quotaService.checkAndIncrement('user-1', 'symptomCheck'),
    ).resolves.toBeUndefined();

    expect(mockUsage.updateMany).toHaveBeenCalled();
  });

  it('re-throws upsert failures that are not a unique-constraint race', async () => {
    mockUsage.upsert.mockRejectedValue(prismaError('P1001'));

    await expect(
      quotaService.checkAndIncrement('user-1', 'symptomCheck'),
    ).rejects.toMatchObject({ code: 'P1001' });

    expect(mockUsage.updateMany).not.toHaveBeenCalled();
  });
});
