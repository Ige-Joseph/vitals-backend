import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { careRepository } from '@/modules/care/care.repository';
import { careService } from '@/modules/care/care.service';
import { medicationRepository } from './medications.repository';
import { generateMedicationSchedule } from './medications.scheduler';
import { FrequencyKey } from '@/config/medication.config';
import { createLogger } from '@/lib/logger';
import type { PrismaTx } from '@/types/prisma';

const log = createLogger('medications-service');

export interface CreateMedicationInput {
  name: string;
  dosage: string;
  frequency: FrequencyKey;
  startDate: string;
  endDate?: string;
  durationDays?: number;
  customTimes?: string[];
  instructions?: string;
}

const parseDateOnly = (value: string, fieldName: string): Date => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest(`Invalid ${fieldName}`);
  }
  return date;
};

export const medicationsService = {
  async createMedication(userId: string, input: CreateMedicationInput) {
    const startDate = parseDateOnly(input.startDate, 'startDate');

    let endDate: Date;
    if (input.endDate) {
      endDate = parseDateOnly(input.endDate, 'endDate');
    } else if (input.durationDays) {
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + input.durationDays - 1);
    } else {
      throw AppError.badRequest('Either endDate or durationDays is required');
    }

    if (endDate < startDate) {
      throw AppError.badRequest('End date must be after or equal to start date');
    }

    const schedule = generateMedicationSchedule({
      medicationName: input.name,
      dosage: input.dosage,
      frequency: input.frequency,
      startDate,
      endDate,
      customTimes: input.customTimes,
      instructions: input.instructions,
    });

    log.info('Schedule generated', {
      userId,
      medication: input.name,
      frequency: input.frequency,
      doses: schedule.length,
    });

    const result = await prisma.$transaction(async (tx: PrismaTx) => {
      const carePlan = await careRepository.createCarePlan(
        {
          userId,
          type: 'MEDICATION',
          title: `${input.name} — ${input.dosage}`,
          metadata: {
            frequency: input.frequency,
            customTimes: input.customTimes ?? null,
          },
        },
        tx,
      );

      const medication = await medicationRepository.create(
        {
          carePlanId: carePlan.id,
          name: input.name,
          dosage: input.dosage,
          frequency: input.frequency,
          startDate,
          endDate,
          instructions: input.instructions,
        },
        tx,
      );

      await careService.scheduleEvents(carePlan.id, userId, schedule, tx);

      await careRepository.createActivityLog(
        {
          userId,
          type: 'MEDICATION_CREATED',
          message: `Medication plan created: ${input.name}`,
          metadata: {
            carePlanId: carePlan.id,
            doses: schedule.length,
            frequency: input.frequency,
          },
        },
        tx,
      );

      return {
        carePlan,
        medication,
        scheduledDoses: schedule.length,
      };
    });

    log.info('Medication plan created', {
      userId,
      carePlanId: result.carePlan.id,
      scheduledDoses: result.scheduledDoses,
    });

    return result;
  },

  async listMedications(userId: string) {
    return medicationRepository.listByUser(userId);
  },

  async getMedication(userId: string, carePlanId: string) {
    const med = await medicationRepository.findWithPlan(carePlanId, userId);
    if (!med) throw AppError.notFound('Medication not found');
    return med;
  },

  async deactivateMedication(userId: string, carePlanId: string) {
    const med = await medicationRepository.findWithPlan(carePlanId, userId);
    if (!med) throw AppError.notFound('Medication not found');

    if (med.carePlan.status === 'COMPLETED') {
      throw AppError.conflict('Medication plan is already completed');
    }

    await prisma.$transaction(async (tx: PrismaTx) => {
      await careRepository.updateCarePlanStatus(carePlanId, 'COMPLETED', tx);

      await careRepository.createActivityLog(
        {
          userId,
          type: 'MEDICATION_DEACTIVATED',
          message: `Medication plan deactivated: ${med.name}`,
          metadata: { carePlanId },
        },
        tx,
      );
    });

    log.info('Medication deactivated', { userId, carePlanId });
  },
};