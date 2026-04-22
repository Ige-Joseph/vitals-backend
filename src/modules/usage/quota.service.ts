import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('quota-service');

type QuotaFeature = 'symptomCheck' | 'drugDetection';

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
  async checkAndIncrement(userId: string, planType: string, feature: QuotaFeature): Promise<void> {
    const today = getToday();
    const limit = getLimit(planType, feature);
    const field =
      feature === 'symptomCheck' ? 'symptomChecksUsed' : 'drugDetectionsUsed';

    // Upsert today's usage row, then atomically increment
    const usage = await prisma.$transaction(async (tx: any) => {
      // Ensure row exists
      await tx.dailyUsage.upsert({
        where: { userId_date: { userId, date: today } },
        create: { userId, date: today },
        update: {},
      });

      // Read current count
      const current = await tx.dailyUsage.findUnique({
        where: { userId_date: { userId, date: today } },
        select: { [field]: true },
      });

      const currentCount = (current as any)[field] as number;

      if (currentCount >= limit) {
        throw AppError.quotaExceeded(
          `You have reached your daily limit of ${limit} ${feature === 'symptomCheck' ? 'symptom checks' : 'drug detections'}. Upgrade to premium for higher limits.`,
        );
      }

      // Increment
      return tx.dailyUsage.update({
        where: { userId_date: { userId, date: today } },
        data: { [field]: { increment: 1 } },
      });
    });

    log.info('Quota incremented', { userId, feature, field, newValue: (usage as any)[field] });
  },

  async getUsage(userId: string, planType: string) {
    const today = getToday();
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
