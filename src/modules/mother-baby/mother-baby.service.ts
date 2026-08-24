import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { careRepository } from '@/modules/care/care.repository';
import { careService } from '@/modules/care/care.service';
import { personAccess } from '@/modules/person/person.access';
import { personService } from '@/modules/person/person.service';
import { personRepository } from '@/modules/person/person.repository';
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
import { calendarService } from '@/modules/calendar/calendar.service';
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
    // Starting a pregnancy is a write on the mother's own record.
    const motherPersonId = await personAccess.resolveSubject(userId, undefined, 'write');

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

    const result = await prisma.$transaction(
      async (tx: PrismaTx) => {
        const carePlan = await careRepository.createCarePlan(
          {
            userId,
            // Pregnancy describes the mother's health, so it stays on her
            // Person. Only post-birth records move to the baby's.
            personId: motherPersonId,
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
            personId: motherPersonId,
            actorUserId: userId,
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
      },
      { timeout: 20000 },
    );

    log.info('Pregnancy setup complete', {
      userId,
      currentWeek,
      trimester,
      ancEventsScheduled: result.ancEventsScheduled,
    });

    try {
      await calendarService.prepareCarePlanSync(userId, result.carePlan.id);
    } catch (error) {
      log.warn('Pregnancy calendar sync skipped or failed', {
        userId,
        carePlanId: result.carePlan.id,
        error,
      });
    }

    return result;
  },

  // ─── Pregnancy Timeline ────────────────────────────────────────────────

  async getTimeline(userId: string) {
    const profile = await motherBabyRepository.findActivePregnancy(userId);
    if (!profile) throw AppError.notFound('No active pregnancy found');

    // Bridge, not a flip. Mother & Baby is scheduled after three other
    // modules, but it shares listCareEvents, which is now person-scoped. The
    // subject here is the caller's own record — the module accepts no
    // personId and its behaviour is unchanged.
    const timelinePersonId = await personAccess.resolveSelfPersonId(userId);

    const currentWeek = getWeekFromLMP(profile.lmpDate);
    const trimester = getTrimester(currentWeek);

    const guidance = getGuidanceForWeek(currentWeek);
    const weekUpdate =
      currentWeek !== profile.currentWeek
        ? motherBabyRepository.updateCurrentWeek(
            profile.carePlanId,
            currentWeek,
            trimester,
          )
        : Promise.resolve(null);

    const [, upcomingANC] = await Promise.all([
      weekUpdate,
      careRepository.listCareEvents({ personId: timelinePersonId, userId }, {
        status: 'PENDING',
        type: 'ANC_VISIT',
        limit: 3,
      }),
    ]);

    return {
      currentWeek,
      trimester,
      expectedDeliveryDate: profile.expectedDeliveryDate,
      lmpDate: profile.lmpDate,
      guidance,
      upcomingANCVisits: upcomingANC,
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
        scheduledFor.setHours(9, 0, 0, 0);

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

    // A second baby consumes managed capacity like any other dependent; the
    // first does not, because the mother-baby journey is core free
    // functionality and the free tier is managedPersonLimit = 0.
    if (await personRepository.hasBabyPerson(userId)) {
      await personService.assertCanAddManagedPerson(userId);
    }

    const result = await prisma.$transaction(
        async (tx: PrismaTx) => {
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

          // The baby is a Person. Records describing the baby's health belong
          // to it, not to the mother — her pregnancy plan, completed just
          // above, keeps her own subject.
          const babyPerson = await personService.createBabyPerson(
            {
              userId,
              displayName: babyName,
              dateOfBirth: deliveryDate,
              origin: 'DELIVERY',
            },
            tx,
          );

          const babyCarePlan = await careRepository.createCarePlan(
            {
              userId,
              personId: babyPerson.id,
              type: 'VACCINATION',
              title: `${babyName} — Vaccination Schedule`,
              metadata: {
                babyName,
                babyPersonId: babyPerson.id,
                deliveryDate: deliveryDate.toISOString(),
              },
            },
            tx,
          );

          await careService.scheduleEvents(babyCarePlan.id, userId, vaccinationEvents, tx);

          await careRepository.createActivityLog(
            {
              userId,
              personId: babyPerson.id,
              actorUserId: userId,
              type: 'DELIVERY_RECORDED',
              message: `Delivery recorded. Baby vaccination plan created for ${babyName}.`,
              metadata: {
                pregnancyCarePlanId: activePregnancy.carePlanId,
                babyCarePlanId: babyCarePlan.id,
                babyPersonId: babyPerson.id,
                deliveryDate: deliveryDate.toISOString(),
                vaccinationsScheduled: vaccinationEvents.length,
              },
            },
            tx,
          );

          return { babyCarePlan, vaccinationsScheduled: vaccinationEvents.length };
        },
        { timeout: 20000 },
      );

    log.info('Delivery recorded, baby vaccination plan created', {
      userId,
      babyCarePlanId: result.babyCarePlan.id,
      vaccinationsScheduled: result.vaccinationsScheduled,
    });

    try {
      await calendarService.prepareCarePlanSync(
        userId,
        result.babyCarePlan.id,
      );
    } catch (error) {
      log.warn('Delivery vaccination calendar sync skipped or failed', {
        userId,
        carePlanId: result.babyCarePlan.id,
        error,
      });
    }

    return result;
  },

  // ─── Baby Profile ──────────────────────────────────────────────────────

  async getBabyProfile(userId: string) {
    const plans = await motherBabyRepository.findAllBabyPlans(userId);
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
      scheduledFor.setHours(9, 0, 0, 0);

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

    // Same rule as the delivery flow. A mother who joins Vitals after giving
    // birth reaches her first baby through this path rather than through
    // delivery, and gating it would gate the journey for her alone — see the
    // report, this reading is flagged for confirmation.
    if (await personRepository.hasBabyPerson(userId)) {
      await personService.assertCanAddManagedPerson(userId);
    }

    const result = await prisma.$transaction(
      async (tx: PrismaTx) => {
        const babyPerson = await personService.createBabyPerson(
          {
            userId,
            displayName: babyName,
            dateOfBirth: deliveryDate,
            origin: 'BABY_PROFILE',
          },
          tx,
        );

        const babyCarePlan = await careRepository.createCarePlan(
          {
            userId,
            personId: babyPerson.id,
            type: 'VACCINATION',
            title: `${babyName} — Vaccination Schedule`,
            metadata: {
              babyName,
              babyPersonId: babyPerson.id,
              deliveryDate: deliveryDate.toISOString(),
              standalone: true,
            },
          },
          tx,
        );

        await careService.scheduleEvents(babyCarePlan.id, userId, vaccinationEvents, tx);

        await careRepository.createActivityLog(
          {
            userId,
            personId: babyPerson.id,
            actorUserId: userId,
            type: 'BABY_PROFILE_CREATED',
            message: `Baby profile created for ${babyName}`,
            metadata: {
              babyCarePlanId: babyCarePlan.id,
              babyPersonId: babyPerson.id,
              vaccinationsScheduled: vaccinationEvents.length,
            },
          },
          tx,
        );

        return { babyCarePlan, vaccinationsScheduled: vaccinationEvents.length };
      },
      { timeout: 20000 },
    );

    log.info('Standalone baby profile created', {
      userId,
      babyCarePlanId: result.babyCarePlan.id,
    });

    try {
      await calendarService.prepareCarePlanSync(userId, result.babyCarePlan.id);
    } catch (error) {
      log.warn('Baby calendar sync skipped or failed', {
        userId,
        carePlanId: result.babyCarePlan.id,
        error,
      });
    }

    return result;
  },

  
  async cancelPregnancyTimeline(userId: string) {
    const activePregnancy = await motherBabyRepository.findActivePregnancy(userId);

    if (!activePregnancy) {
      throw AppError.notFound('No active pregnancy timeline found');
    }

    const result = await prisma.$transaction(
      async (tx: PrismaTx) => {
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

        const updatedCarePlan = await careRepository.updateCarePlanStatus(
          activePregnancy.carePlanId,
          'PAUSED',
          tx,
        );

        await careRepository.createActivityLog(
          {
            userId,
            type: 'PREGNANCY_CANCELLED',
            message: 'Pregnancy timeline cancelled by user',
            metadata: {
              carePlanId: activePregnancy.carePlanId,
              reason: 'USER_CANCELLED',
            },
          },
          tx,
        );

        return {
          carePlanId: updatedCarePlan.id,
          status: updatedCarePlan.status,
        };
      },
      { timeout: 20000 },
    );

    log.info('Pregnancy timeline cancelled', {
      userId,
      carePlanId: result.carePlanId,
    });

    try {
      await calendarService.cleanupCarePlanEvents(userId, result.carePlanId);
    } catch (error) {
      log.warn('Pregnancy calendar cleanup skipped or failed', {
        userId,
        carePlanId: result.carePlanId,
        error,
      });
    }

    return result;
  },



  async cancelBabyTimeline(userId: string) {
    const activePlan = await motherBabyRepository.findActiveBabyPlan(userId);

    if (!activePlan) {
      throw AppError.notFound('No active baby timeline found');
    }

    const result = await prisma.$transaction(async (tx) => {
      const events = await tx.careEvent.findMany({
        where: {
          carePlanId: activePlan.id,
          status: 'PENDING',
        },
        select: { id: true },
      });

      for (const event of events) {
        await careRepository.cancelRemindersByCareEvent(event.id, tx);
      }

      const updated = await careRepository.updateCarePlanStatus(
        activePlan.id,
        'PAUSED',
        tx,
      );

      await careRepository.createActivityLog(
        {
          userId,
          type: 'BABY_TIMELINE_CANCELLED',
          message: 'Baby vaccination timeline cancelled',
          metadata: { carePlanId: activePlan.id },
        },
        tx,
      );

      return updated;
    });

    try {
      await calendarService.cleanupCarePlanEvents(userId, result.id);
    } catch (error) {
      log.warn('Baby calendar cleanup skipped or failed', {
        userId,
        carePlanId: result.id,
        error,
      });
    }

    return result;
  },
};
