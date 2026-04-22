import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { careRepository } from '@/modules/care/care.repository';
import { careService } from '@/modules/care/care.service';
import { motherBabyRepository } from './mother-baby.repository';
import {
  getWeekFromLMP,
  getEDD,
  getTrimester,
  getLMPFromWeek,
  getRemainingANCMilestones,
  getGuidanceForWeek,
  ANC_MILESTONES,
  VACCINATION_SCHEDULE,
} from '@/config/pregnancy.config';
import { createLogger } from '@/lib/logger';
import type { PrismaTx } from '@/types/prisma';

const log = createLogger('mother-baby-service');

// How many days before an ANC visit to send the reminder
const ANC_REMINDER_DAYS_BEFORE = 3;

const parseDateOnly = (value: string, fieldName: string): Date => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest(`Invalid ${fieldName}`);
  }
  return date;
};

export const motherBabyService = {
  // ─── Pregnancy Setup ────────────────────────────────────────────────────

  async setupPregnancy(
    userId: string,
    input: { lmpDate?: string; pregnancyWeekAtSetup?: number },
  ) {
    const existing = await motherBabyRepository.findActivePregnancy(userId);
    if (existing) {
      throw AppError.conflict(
        'You already have an active pregnancy. Complete or close it before starting a new one.',
      );
    }

    let lmpDate: Date;
    if (input.lmpDate) {
      lmpDate = parseDateOnly(input.lmpDate, 'lmpDate');
    } else if (input.pregnancyWeekAtSetup !== undefined) {
      lmpDate = getLMPFromWeek(input.pregnancyWeekAtSetup);
    } else {
      throw AppError.badRequest('Either lmpDate or pregnancyWeekAtSetup is required');
    }

    const currentWeek = getWeekFromLMP(lmpDate);
    const trimester = getTrimester(currentWeek);
    const edd = getEDD(lmpDate);

    if (currentWeek < 1 || currentWeek > 42) {
      throw AppError.badRequest('Calculated pregnancy week is out of valid range (1–42)');
    }

    const remainingMilestones = getRemainingANCMilestones(currentWeek);

    const ancEvents = remainingMilestones.map((milestone) => {
      const scheduledFor = new Date(lmpDate);
      scheduledFor.setDate(scheduledFor.getDate() + milestone.weekNumber * 7);

      const reminderOffsetMinutes = ANC_REMINDER_DAYS_BEFORE * 24 * 60;

      return {
        eventType: milestone.eventType,
        title: milestone.title,
        description: milestone.description,
        scheduledFor,
        metadata: { weekNumber: milestone.weekNumber },
        reminderOffsetMinutes,
      };
    });

    const result = await prisma.$transaction(async (tx: PrismaTx) => {
      const carePlan = await careRepository.createCarePlan(
        {
          userId,
          type: 'PREGNANCY',
          title: `Pregnancy — EDD ${edd.toDateString()}`,
          metadata: { lmpDate: lmpDate.toISOString(), edd: edd.toISOString() },
        },
        tx,
      );

      const pregnancyProfile = await motherBabyRepository.createPregnancyProfile(
        {
          carePlanId: carePlan.id,
          lmpDate,
          pregnancyWeekAtSetup: currentWeek,
          currentWeek,
          trimester,
          expectedDeliveryDate: edd,
        },
        tx,
      );

      await careService.scheduleEvents(carePlan.id, userId, ancEvents, tx);

      await careRepository.createActivityLog(
        {
          userId,
          type: 'PREGNANCY_STARTED',
          message: `Pregnancy timeline started at week ${currentWeek}`,
          metadata: {
            carePlanId: carePlan.id,
            currentWeek,
            trimester,
            edd: edd.toISOString(),
            ancEventsScheduled: ancEvents.length,
          },
        },
        tx,
      );

      return { carePlan, pregnancyProfile, ancEventsScheduled: ancEvents.length };
    });

    log.info('Pregnancy setup complete', {
      userId,
      currentWeek,
      trimester,
      ancEventsScheduled: result.ancEventsScheduled,
    });

    return result;
  },

  // ─── Pregnancy Timeline ────────────────────────────────────────────────

  async getTimeline(userId: string) {
    const profile = await motherBabyRepository.findActivePregnancy(userId);
    if (!profile) throw AppError.notFound('No active pregnancy found');

    const currentWeek = getWeekFromLMP(profile.lmpDate);
    const trimester = getTrimester(currentWeek);

    if (currentWeek !== profile.currentWeek) {
      await motherBabyRepository.updateCurrentWeek(
        profile.carePlanId,
        currentWeek,
        trimester,
      );
    }

    const guidance = getGuidanceForWeek(currentWeek);
    const upcomingANC = await careRepository.listCareEvents(userId, {
      status: 'PENDING',
      type: 'ANC_VISIT',
    });

    return {
      currentWeek,
      trimester,
      expectedDeliveryDate: profile.expectedDeliveryDate,
      lmpDate: profile.lmpDate,
      guidance,
      upcomingANCVisits: upcomingANC.slice(0, 3),
      allMilestones: ANC_MILESTONES,
    };
  },

  // ─── Delivery Transition ──────────────────────────────────────────────

  async recordDelivery(
    userId: string,
    input: { deliveryDate: string; babyName?: string },
  ) {
    const activePregnancy = await motherBabyRepository.findActivePregnancy(userId);
    if (!activePregnancy) {
      throw AppError.notFound('No active pregnancy found to complete');
    }

    if (activePregnancy.carePlan.status === 'COMPLETED') {
      throw AppError.conflict('Pregnancy plan is already marked as completed');
    }

    const deliveryDate = parseDateOnly(input.deliveryDate, 'deliveryDate');
    const babyName = input.babyName ?? 'Baby';

    const vaccinationEvents = VACCINATION_SCHEDULE.map((vaccine) => {
      const scheduledFor = new Date(deliveryDate);
      scheduledFor.setDate(scheduledFor.getDate() + vaccine.ageWeeks * 7);

      return {
        eventType: vaccine.eventType,
        title: `${babyName}: ${vaccine.ageLabel} vaccines`,
        description: vaccine.vaccines.join(', '),
        scheduledFor,
        metadata: {
          babyName,
          ageLabel: vaccine.ageLabel,
          ageWeeks: vaccine.ageWeeks,
          vaccines: vaccine.vaccines,
        },
        reminderOffsetMinutes: 3 * 24 * 60,
      };
    });

    const result = await prisma.$transaction(async (tx: PrismaTx) => {
      // Cancel pending reminders for pregnancy events before closing plan
      const pregnancyEvents = await tx.careEvent.findMany({
        where: {
          carePlanId: activePregnancy.carePlanId,
          status: 'PENDING',
        },
        select: { id: true },
      });

      for (const event of pregnancyEvents) {
        await careRepository.cancelRemindersByCareEvent(event.id, tx);
      }

      await careRepository.updateCarePlanStatus(activePregnancy.carePlanId, 'COMPLETED', tx);

      const babyCarePlan = await careRepository.createCarePlan(
        {
          userId,
          type: 'VACCINATION',
          title: `${babyName} — Vaccination Schedule`,
          metadata: { babyName, deliveryDate: deliveryDate.toISOString() },
        },
        tx,
      );

      await careService.scheduleEvents(babyCarePlan.id, userId, vaccinationEvents, tx);

      await careRepository.createActivityLog(
        {
          userId,
          type: 'DELIVERY_RECORDED',
          message: `Delivery recorded. Baby vaccination plan created for ${babyName}.`,
          metadata: {
            pregnancyCarePlanId: activePregnancy.carePlanId,
            babyCarePlanId: babyCarePlan.id,
            deliveryDate: deliveryDate.toISOString(),
            vaccinationsScheduled: vaccinationEvents.length,
          },
        },
        tx,
      );

      return { babyCarePlan, vaccinationsScheduled: vaccinationEvents.length };
    });

    log.info('Delivery recorded, baby vaccination plan created', {
      userId,
      babyCarePlanId: result.babyCarePlan.id,
      vaccinationsScheduled: result.vaccinationsScheduled,
    });

    return result;
  },

  // ─── Baby Profile ──────────────────────────────────────────────────────

  async getBabyProfile(userId: string) {
    const plans = await motherBabyRepository.findAllBabyPlans(userId);
    if (!plans.length) throw AppError.notFound('No baby profile found');
    return plans;
  },

  async createStandaloneBabyProfile(
    userId: string,
    input: { deliveryDate: string; babyName?: string },
  ) {
    const deliveryDate = parseDateOnly(input.deliveryDate, 'deliveryDate');
    const babyName = input.babyName ?? 'Baby';

    const vaccinationEvents = VACCINATION_SCHEDULE.map((vaccine) => {
      const scheduledFor = new Date(deliveryDate);
      scheduledFor.setDate(scheduledFor.getDate() + vaccine.ageWeeks * 7);

      return {
        eventType: vaccine.eventType,
        title: `${babyName}: ${vaccine.ageLabel} vaccines`,
        description: vaccine.vaccines.join(', '),
        scheduledFor,
        metadata: {
          babyName,
          ageLabel: vaccine.ageLabel,
          ageWeeks: vaccine.ageWeeks,
          vaccines: vaccine.vaccines,
        },
        reminderOffsetMinutes: 3 * 24 * 60,
      };
    });

    const result = await prisma.$transaction(async (tx: PrismaTx) => {
      const babyCarePlan = await careRepository.createCarePlan(
        {
          userId,
          type: 'VACCINATION',
          title: `${babyName} — Vaccination Schedule`,
          metadata: { babyName, deliveryDate: deliveryDate.toISOString(), standalone: true },
        },
        tx,
      );

      await careService.scheduleEvents(babyCarePlan.id, userId, vaccinationEvents, tx);

      await careRepository.createActivityLog(
        {
          userId,
          type: 'BABY_PROFILE_CREATED',
          message: `Baby profile created for ${babyName}`,
          metadata: {
            babyCarePlanId: babyCarePlan.id,
            vaccinationsScheduled: vaccinationEvents.length,
          },
        },
        tx,
      );

      return { babyCarePlan, vaccinationsScheduled: vaccinationEvents.length };
    });

    log.info('Standalone baby profile created', {
      userId,
      babyCarePlanId: result.babyCarePlan.id,
    });

    return result;
  },
};