import { quotaService } from '@/modules/usage/quota.service';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';

jest.mock('@/lib/prisma', () => ({
  prisma: {
    // The tier is read from the database now, not from the access token, so a
    // token minted before an upgrade cannot serve stale limits.
    user: { findUnique: jest.fn() },
    // Entitlement resolves from subscription state; no subscription means the
    // tier falls back to the projection on User.
    subscription: { findFirst: jest.fn().mockResolvedValue(null) },

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
const onTier = (planType: 'FREE' | 'PREMIUM') =>
  mockUser.findUnique.mockResolvedValue({ planType });

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
