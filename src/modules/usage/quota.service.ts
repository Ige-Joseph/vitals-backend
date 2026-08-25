import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('quota-service');

type QuotaFeature = 'symptomCheck' | 'drugDetection';

/**
 * The tier is read from the database, never from the access token.
 *
 * The token carries planType and lives for 15 minutes, so a token minted
 * before an upgrade says FREE afterwards. Serving entitlement from it is the
 * "I paid and nothing happened" bug: the user is charged and then told they
 * have run out of checks. One indexed lookup is the right price for that.
 */
const readTier = async (userId: string): Promise<string> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { planType: true },
  });
  return user?.planType ?? 'FREE';
};

const getLimit = (planType: string, feature: QuotaFeature): number => {
  const isPremium = planType === 'PREMIUM';
  if (feature === 'symptomCheck') {
    return isPremium ? env.PREMIUM_SYMPTOM_CHECKS_PER_DAY : env.FREE_SYMPTOM_CHECKS_PER_DAY;
  }
  return isPremium ? env.PREMIUM_DRUG_DETECTIONS_PER_DAY : env.FREE_DRUG_DETECTIONS_PER_DAY;
};

const getToday = (): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

export const quotaService = {
  /**
   * Checks quota and atomically increments usage if within limit.
   * Throws QUOTA_EXCEEDED if the user is at their daily limit.
   * Must be called before any AI operation.
   */
  async checkAndIncrement(userId: string, feature: QuotaFeature): Promise<void> {
    const today = getToday();
    const limit = getLimit(await readTier(userId), feature);
    const field = feature === 'symptomCheck' ? 'symptomChecksUsed' : 'drugDetectionsUsed';

    // Ensure today's row exists. Two first-calls of the day can both find it
    // missing, so whichever loses the insert race is treated as a success —
    // the row it needed is there either way.
    try {
      await prisma.dailyUsage.upsert({
        where: { userId_date: { userId, date: today } },
        create: { userId, date: today },
        update: {},
      });
    } catch (err) {
      if ((err as any).code !== 'P2002') throw err;
    }

    // Claim one unit against the limit in a single conditional update, the way
    // claimReminder claims a reminder. Concurrent callers serialise on the row
    // and re-evaluate the limit after the winner commits, so count === 0 means
    // the limit really was reached — never a lost update.
    const claimed = await prisma.dailyUsage.updateMany({
      where:
        feature === 'symptomCheck'
          ? { userId, date: today, symptomChecksUsed: { lt: limit } }
          : { userId, date: today, drugDetectionsUsed: { lt: limit } },
      data:
        feature === 'symptomCheck'
          ? { symptomChecksUsed: { increment: 1 } }
          : { drugDetectionsUsed: { increment: 1 } },
    });

    if (claimed.count === 0) {
      throw AppError.quotaExceeded(
        `You have reached your daily limit of ${limit} ${feature === 'symptomCheck' ? 'symptom checks' : 'drug detections'}. Upgrade to premium for higher limits.`,
      );
    }

    log.info('Quota claimed', { userId, feature, field, limit });
  },

  async getUsage(userId: string) {
    const today = getToday();
    const planType = await readTier(userId);
    const usage = await prisma.dailyUsage.findUnique({
      where: { userId_date: { userId, date: today } },
    });

    return {
      symptomChecks: {
        used: usage?.symptomChecksUsed ?? 0,
        limit: getLimit(planType, 'symptomCheck'),
      },
      drugDetections: {
        used: usage?.drugDetectionsUsed ?? 0,
        limit: getLimit(planType, 'drugDetection'),
      },
    };
  },
};
