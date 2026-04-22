import { careRepository } from '@/modules/care/care.repository';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('dashboard-service');

export const dashboardService = {
  async getDashboard(userId: string) {
    const [
      todayTasks,
      upcomingReminders,
      recentActivity,
      usageSummary,
      latestMoodInsight,
      motherBabySummary,
    ] = await Promise.all([
      careRepository.getTodayCareEvents(userId),
      careRepository.getUpcomingCareEvents(userId, 5),
      careRepository.getRecentActivity(userId, 10),
      dashboardService.getUsageSummary(userId),
      dashboardService.getLatestMoodInsight(userId),
      dashboardService.getMotherBabySummary(userId),
    ]);

    return {
      todayTasks,
      upcomingReminders,
      recentActivity,
      usageSummary,
      latestMoodInsight,
      motherBabySummary,
    };
  },

  async getUsageSummary(userId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const usage = await prisma.dailyUsage.findUnique({
      where: { userId_date: { userId, date: today } },
    });

    return {
      symptomChecksUsed: usage?.symptomChecksUsed ?? 0,
      symptomChecksLimit: env.FREE_SYMPTOM_CHECKS_PER_DAY,
      drugDetectionsUsed: usage?.drugDetectionsUsed ?? 0,
      drugDetectionsLimit: env.FREE_DRUG_DETECTIONS_PER_DAY,
    };
  },

  async getLatestMoodInsight(userId: string) {
    const latest = await prisma.moodLog.findFirst({
      where: { userId },
      orderBy: { loggedAt: 'desc' },
      select: { mood: true, craving: true, insight: true, loggedAt: true },
    });

    return latest ?? null;
  },

  async getMotherBabySummary(userId: string) {
    const [
      totalPregnancies,
      activePregnancies,
      completedPregnancies,
      totalBabies,
      standaloneBabies,
    ] = await Promise.all([
      prisma.carePlan.count({
        where: {
          userId,
          type: 'PREGNANCY',
        },
      }),
      prisma.carePlan.count({
        where: {
          userId,
          type: 'PREGNANCY',
          status: 'ACTIVE',
        },
      }),
      prisma.carePlan.count({
        where: {
          userId,
          type: 'PREGNANCY',
          status: 'COMPLETED',
        },
      }),
      prisma.carePlan.count({
        where: {
          userId,
          type: 'VACCINATION',
        },
      }),
      prisma.carePlan.count({
        where: {
          userId,
          type: 'VACCINATION',
          metadata: {
            path: ['standalone'],
            equals: true,
          },
        },
      }),
    ]);

    return {
      pregnancies: {
        total: totalPregnancies,
        active: activePregnancies,
        completed: completedPregnancies,
      },
      babies: {
        total: totalBabies,
        standalone: standaloneBabies,
        fromPregnancy: totalBabies - standaloneBabies,
      },
    };
  },
};