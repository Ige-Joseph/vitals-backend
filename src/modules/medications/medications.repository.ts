import { prisma } from '@/lib/prisma';
import { carePlanScope, type PersonScope } from '@/modules/care/care.repository';
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

  /**
   * Person-scoped, per the repository convention. Authorization has already
   * happened via assertPersonAccess; this filter is what stops a caller who
   * knows a carePlanId from reading a plan outside that subject.
   */
  findWithPlan(carePlanId: string, scope: PersonScope) {
    return prisma.medication.findFirst({
      where: { carePlanId, carePlan: carePlanScope(scope) },
      include: { carePlan: true },
    });
  },

  listByPerson(scope: PersonScope) {
    return prisma.medication.findMany({
      where: {
        carePlan: { ...carePlanScope(scope), status: { not: 'COMPLETED' } },
      },
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






};