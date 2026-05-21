import { DraftStatus } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { careRepository } from '@/modules/care/care.repository';
import { careService } from '@/modules/care/care.service';
import { aiMedicationDraftsRepository } from '@/modules/ai-medication-drafts/ai-medication-drafts.repository';
import { medicationRepository } from './medications.repository';
import { generateMedicationSchedule } from './medications.scheduler';
import { FrequencyKey } from '@/config/medication.config';
import { createLogger } from '@/lib/logger';
import type { PrismaTx } from '@/types/prisma';
import { calendarService } from '@/modules/calendar/calendar.service';

const log = createLogger('medications-service');
const FREE_MEDICATION_PLAN_LIMIT = 5;

export interface CreateMedicationInput {
  name: string;
  dosage: string;
  frequency: FrequencyKey;
  startDate: string;
  endDate?: string;
  durationDays?: number;
  customTimes?: string[];
  instructions?: string;
  aiDraftId?: string;
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

    const activeMedicationCount = await medicationRepository.countActiveByUser(userId);

    if (activeMedicationCount >= FREE_MEDICATION_PLAN_LIMIT) {
      throw AppError.badRequest(
        `You can only create up to ${FREE_MEDICATION_PLAN_LIMIT} active medication plans for now`,
      );
    }

    let aiDraftIdToConfirm: string | undefined;

    if (input.aiDraftId) {
      const draft = await aiMedicationDraftsRepository.findByIdForUser(
        input.aiDraftId,
        userId,
      );

      if (!draft) {
        throw AppError.notFound('AI medication draft not found');
      }

      if (draft.status === DraftStatus.CANCELLED) {
        throw AppError.badRequest('This AI medication draft has been cancelled.');
      }

      if (draft.status === DraftStatus.CONFIRMED) {
        throw AppError.badRequest('This AI medication draft has already been used.');
      }

      if (draft.expiresAt < new Date()) {
        throw AppError.badRequest('This AI medication draft has expired. Please start again.');
      }

      aiDraftIdToConfirm = draft.id;
    }

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
      aiDraftId: aiDraftIdToConfirm,
    });

    const result = await prisma.$transaction(
      async (tx: PrismaTx) => {
        const carePlan = await careRepository.createCarePlan(
          {
            userId,
            type: 'MEDICATION',
            title: `${input.name} — ${input.dosage}`,
            metadata: {
              frequency: input.frequency,
              customTimes: input.customTimes ?? null,
              aiDraftId: aiDraftIdToConfirm ?? null,
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

        if (aiDraftIdToConfirm) {
          await tx.medicationDraft.update({
            where: { id: aiDraftIdToConfirm },
            data: {
              status: DraftStatus.CONFIRMED,
              lastQuestion: null,
            },
          });
        }

        await careRepository.createActivityLog(
          {
            userId,
            type: 'MEDICATION_CREATED',
            message: `Medication plan created: ${input.name}`,
            metadata: {
              carePlanId: carePlan.id,
              doses: schedule.length,
              frequency: input.frequency,
              aiDraftId: aiDraftIdToConfirm ?? null,
            },
          },
          tx,
        );

        return {
          carePlan,
          medication,
          scheduledDoses: schedule.length,
        };
      },
      {
        timeout: 60000,
      },
    );

    log.info('Medication plan created', {
      userId,
      carePlanId: result.carePlan.id,
      scheduledDoses: result.scheduledDoses,
      aiDraftId: aiDraftIdToConfirm,
    });


    

    // Commented out calendar sync for now to avoid issues during medication creation. Will revisit after initial launch when we have more stability and better error monitoring in place.

    //     let calendarSync = null;

    // try {
    //   calendarSync = await calendarService.prepareCarePlanSync(
    //     userId,
    //     result.carePlan.id,
    //   );
    // } catch (error: any) {
    //   log.error('Calendar sync failed during medication creation', {
    //     userId,
    //     carePlanId: result.carePlan.id,
    //     error: error.message,
    //   });

    //   calendarSync = {
    //     failed: true,
    //     message: error.message ?? 'Calendar sync failed',
    //   };
    // }

    // return {
    //   ...result,
    //   calendarSync,
    // };


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

    if (!med) {
      throw AppError.notFound('Medication not found');
    }

    await prisma.$transaction(async (tx: PrismaTx) => {
      await careRepository.updateCarePlanStatus(
        carePlanId,
        'COMPLETED',
        tx,
      );

      await careRepository.cancelRemindersByCarePlan(
        carePlanId,
        tx,
      );

      await careRepository.markPendingEventsSkippedByCarePlan(
        carePlanId,
        tx,
      );

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

    let calendarCleanup = null;

    try {
      calendarCleanup = await calendarService.cleanupCarePlanEvents(
        userId,
        carePlanId,
      );
    } catch (error: any) {
      log.error('Calendar cleanup failed during medication deactivation', {
        userId,
        carePlanId,
        error: error.message,
      });

      calendarCleanup = {
        failed: true,
        message: error.message ?? 'Calendar cleanup failed',
      };
    }

    log.info('Medication deactivated', {
      userId,
      carePlanId,
    });

    return {
      success: true,
      calendarCleanup,
    };
  },

  async getMedicationHistory(userId: string, carePlanId: string) {
    const med = await medicationRepository.findWithPlan(carePlanId, userId);
    if (!med) throw AppError.notFound('Medication not found');

    return careRepository.listEventsByCarePlan(carePlanId, userId);
  },
};