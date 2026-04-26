import { prisma } from '@/lib/prisma';
import type { PrismaTx } from '@/types/prisma';
import type { FrequencyKey } from '@/config/medication.config';

export interface CreateMedicationInput {
  carePlanId: string;
  name: string;
  dosage: string;
  frequency: FrequencyKey;
  startDate: Date;
  endDate?: Date;
  instructions?: string;
}

export const medicationRepository = {
  create(data: CreateMedicationInput, tx?: PrismaTx) {
    const client = tx ?? prisma;
    return client.medication.create({ data });
  },

  findByCarePlanId(carePlanId: string) {
    return prisma.medication.findUnique({ where: { carePlanId } });
  },

  findWithPlan(carePlanId: string, userId: string) {
    return prisma.medication.findFirst({
      where: { carePlanId, carePlan: { userId } },
      include: { carePlan: true },
    });
  },

  listByUser(userId: string) {
    return prisma.medication.findMany({
      where: { carePlan: { userId, status: { not: 'COMPLETED' } } },
      include: {
        carePlan: {
          select: { id: true, status: true, title: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  update(
    carePlanId: string,
    data: Partial<CreateMedicationInput>,
    tx?: PrismaTx,
  ) {
    const client = tx ?? prisma;
    return client.medication.update({ where: { carePlanId }, data });
  },


  countActiveByUser(userId: string) {
    return prisma.medication.count({
      where: {
        carePlan: {
          userId,
          status: {
            not: 'COMPLETED',
          },
        },
      },
    });
  },






};