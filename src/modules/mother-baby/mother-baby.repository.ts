import { prisma } from '@/lib/prisma';
import type { PrismaTx } from '@/types/prisma';

export interface CreatePregnancyProfileInput {
  carePlanId: string;
  lmpDate: Date;
  pregnancyWeekAtSetup: number;
  currentWeek: number;
  trimester: number;
  expectedDeliveryDate: Date;
}

export const motherBabyRepository = {
  // ─── Pregnancy ─────────────────────────────────────────────────────────

  createPregnancyProfile(data: CreatePregnancyProfileInput, tx?: PrismaTx) {
    const client = tx ?? prisma;
    return client.pregnancyProfile.create({ data });
  },

  findActivePregnancy(userId: string) {
    return prisma.pregnancyProfile.findFirst({
      where: { carePlan: { userId, status: 'ACTIVE', type: 'PREGNANCY' } },
      include: { carePlan: true },
    });
  },

  findPregnancyByCarePlanId(carePlanId: string, userId: string) {
    return prisma.pregnancyProfile.findFirst({
      where: { carePlanId, carePlan: { userId } },
      include: { carePlan: true },
    });
  },

  updateCurrentWeek(carePlanId: string, currentWeek: number, trimester: number) {
    return prisma.pregnancyProfile.update({
      where: { carePlanId },
      data: { currentWeek, trimester },
    });
  },

  // ─── Baby vaccination care plan ────────────────────────────────────────

  findActiveBabyPlan(userId: string) {
    return prisma.carePlan.findFirst({
      where: { userId, type: 'VACCINATION', status: 'ACTIVE' },
      include: {
        careEvents: {
          where: { status: { in: ['PENDING', 'DONE'] } },
          orderBy: { scheduledFor: 'asc' },
        },
      },
    });
  },

  findAllBabyPlans(userId: string) {
    return prisma.carePlan.findMany({
      where: { userId, type: 'VACCINATION' },
      orderBy: { createdAt: 'desc' },
      include: {
        careEvents: {
          orderBy: { scheduledFor: 'asc' },
          select: {
            id: true,
            title: true,
            scheduledFor: true,
            status: true,
            metadata: true,
          },
        },
      },
    });
  },
};
