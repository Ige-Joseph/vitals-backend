import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { env } from '@/config/env';
import type { PrismaTx } from '@/types/prisma';
import { personAccess } from '@/modules/person/person.access';
import { careRepository } from '@/modules/care/care.repository';
import { calendarService } from '@/modules/calendar/calendar.service';
import { appointmentsRepository } from './appointments.repository';
import type {
  CreateAppointmentInput,
  ListAppointmentsInput,
  UpdateAppointmentInput,
} from './appointments.validators';

const log = createLogger('appointments');

/**
 * Appointments.
 *
 * Person-native from the first line. The clinical subject is always a Person;
 * the account is only ever the caller, and it earns its way to a Person
 * through a membership rather than by owning the row. Every method here begins
 * by resolving the subject and refuses before it reads anything.
 *
 * ── Shape ────────────────────────────────────────────────────────────────
 *
 * One appointment is a CarePlan of type APPOINTMENT (the care engine's root,
 * which is what CareEvent, Reminder and calendar sync all hang from), a 1:1
 * Appointment row carrying the structured detail, and one CareEvent at the
 * appointment time with a reminder per configured lead. This is the same
 * composition Medication and PregnancyProfile use, so nothing in the engine
 * had to learn a new shape.
 *
 * The plan's own lifecycle is used narrowly. ACTIVE while the appointment is
 * ahead of us, COMPLETED once it is done or called off. PAUSED is never
 * written: pausing is a thing you do to a course of treatment, not to a moment
 * in time.
 *
 * ── The two writes that are not just a column ─────────────────────────────
 *
 * Rescheduling and cancelling both have consequences beyond the Appointment
 * row — reminders that must not fire for a time that no longer exists, a
 * calendar entry that must not sit in someone's diary. Both are transactional
 * over the database, and both treat calendar sync as something that happens
 * afterwards and is allowed to fail.
 */

/** Calendar sync is never allowed to take a care flow down with it. */
const syncCalendar = async (
  action: 'prepare' | 'cleanup',
  userId: string,
  carePlanId: string,
): Promise<void> => {
  try {
    if (action === 'prepare') {
      await calendarService.prepareCarePlanSync(userId, carePlanId);
    } else {
      await calendarService.cleanupCarePlanEvents(userId, carePlanId);
    }
  } catch (error: any) {
    // Warned, not thrown, and deliberately after the transaction has already
    // committed. An appointment that exists but is not in someone's Google
    // Calendar is a degraded appointment; an appointment that failed to be
    // booked because Google was unreachable is a lost one.
    log.warn('Appointment calendar sync skipped or failed', {
      action,
      userId,
      carePlanId,
      error: error?.message ?? error,
    });
  }
};

/**
 * Lay down the one care event an appointment is, and its reminders.
 *
 * One event, several reminders — not one event per reminder. The distinction
 * matters beyond tidiness: a CareEvent is what the calendar syncs, so an event
 * per lead time would put the same appointment in someone's diary twice, and
 * `careService.scheduleEvents` pairs each event with exactly one reminder. So
 * the event and its reminders are written directly through the care
 * repository, which is the same engine either way.
 *
 * A lead time already in the past simply produces no reminder. Booking
 * something for tomorrow should not fail because a day-ahead reminder for it
 * would have had to be sent yesterday.
 */
const scheduleAppointmentEvent = async (
  carePlanId: string,
  input: {
    title: string;
    startsAt: Date;
    leads: number[];
    location?: string | null;
    clinician?: string | null;
  },
  tx: PrismaTx,
): Promise<void> => {
  const description =
    [input.clinician, input.location].filter(Boolean).join(' · ') || undefined;

  const event = await careRepository.createCareEvent(
    {
      carePlanId,
      eventType: 'APPOINTMENT',
      title: input.title,
      description,
      scheduledFor: input.startsAt,
    },
    tx,
  );

  const now = Date.now();
  const reminders = input.leads
    .map((leadMinutes) => new Date(input.startsAt.getTime() - leadMinutes * 60_000))
    .filter((sendAt) => sendAt.getTime() > now)
    .map((sendAt) => ({ careEventId: event.id, channel: 'PUSH' as const, sendAt }));

  if (reminders.length > 0) {
    await careRepository.createManyReminders(reminders, tx);
  }
};

/**
 * A title for the plan row.
 *
 * The plan carries a title because every plan does and the dashboard reads it;
 * the appointment's own fields stay on the appointment.
 */
const planTitle = (title: string) => title.trim();

export const appointmentsService = {
  /**
   * Book one.
   *
   * Order matters: access first, then the whole database write in one
   * transaction, then the calendar. Nothing provider-facing happens inside the
   * transaction — a slow external call holding a write transaction open is how
   * a booking flow starts timing out under load.
   */
  async create(userId: string, input: CreateAppointmentInput) {
    const personId = await personAccess.resolveSubject(userId, input.personId, 'write');

    if (input.startsAt.getTime() <= Date.now()) {
      throw AppError.badRequest('An appointment must be scheduled in the future');
    }

    const leads = input.reminderLeadMinutes ?? [1440, 60];

    const result = await prisma.$transaction(async (tx: PrismaTx) => {
      const carePlan = await careRepository.createCarePlan(
        {
          userId,
          // The subject this plan is about. userId stays alongside it for the
          // compatibility window, exactly as the medication path does.
          personId,
          type: 'APPOINTMENT',
          title: planTitle(input.title),
          // Empty, and staying empty. The structured detail is on the
          // Appointment row where it can be typed and queried.
          metadata: {},
        },
        tx,
      );

      const appointment = await appointmentsRepository.create(
        {
          carePlanId: carePlan.id,
          personId,
          startsAt: input.startsAt,
          durationMinutes: input.durationMinutes,
          clinician: input.clinician,
          specialty: input.specialty,
          location: input.location,
          reason: input.reason,
          notes: input.notes,
          reminderLeadMinutes: leads,
          createdByUserId: userId,
        },
        tx,
      );

      await scheduleAppointmentEvent(
        carePlan.id,
        {
          title: planTitle(input.title),
          startsAt: input.startsAt,
          leads,
          location: input.location,
          clinician: input.clinician,
        },
        tx,
      );

      await careRepository.createActivityLog(
        {
          userId,
          personId,
          actorUserId: userId,
          type: 'APPOINTMENT_CREATED',
          message: `Appointment scheduled: ${planTitle(input.title)}`,
          metadata: { appointmentId: appointment.id, carePlanId: carePlan.id },
        },
        tx,
      );

      return { carePlan, appointment };
    });

    log.info('Appointment created', {
      userId,
      personId,
      appointmentId: result.appointment.id,
      leads: leads.length,
    });

    await syncCalendar('prepare', userId, result.carePlan.id);

    return result.appointment;
  },

  async list(userId: string, filters: ListAppointmentsInput) {
    const personId = await personAccess.resolveSubject(userId, filters.personId, 'read');

    return appointmentsRepository.listForPerson(personId, {
      scope: filters.scope,
      status: filters.status,
      limit: filters.limit,
      now: new Date(),
    });
  },

  async get(userId: string, appointmentId: string, requestedPersonId?: string) {
    const personId = await personAccess.resolveSubject(userId, requestedPersonId, 'read');

    const appointment = await appointmentsRepository.findForPerson(appointmentId, personId);
    if (!appointment) throw AppError.notFound('Appointment not found');

    return appointment;
  },

  /**
   * Change one.
   *
   * A change to the time is not the same as a change to the notes. Moving an
   * appointment invalidates every reminder already scheduled for it, so the
   * events are withdrawn and re-derived; changing anything else leaves the
   * schedule alone. Getting this wrong in either direction is a real failure —
   * a reminder for a time that no longer exists, or no reminder at all.
   */
  async update(
    userId: string,
    appointmentId: string,
    input: UpdateAppointmentInput,
    requestedPersonId?: string,
  ) {
    const personId = await personAccess.resolveSubject(userId, requestedPersonId, 'write');

    const existing = await appointmentsRepository.findForPerson(appointmentId, personId);
    if (!existing) throw AppError.notFound('Appointment not found');

    if (existing.status === 'CANCELLED') {
      throw AppError.conflict('This appointment has been cancelled');
    }
    if (existing.status === 'COMPLETED') {
      throw AppError.conflict('This appointment has already happened');
    }

    if (input.startsAt && input.startsAt.getTime() <= Date.now()) {
      throw AppError.badRequest('An appointment must be scheduled in the future');
    }

    const rescheduled =
      Boolean(input.startsAt) && input.startsAt!.getTime() !== existing.startsAt.getTime();
    const leadsChanged = Boolean(input.reminderLeadMinutes);

    const startsAt = input.startsAt ?? existing.startsAt;
    const leads = input.reminderLeadMinutes ?? existing.reminderLeadMinutes;
    const title = input.title ?? existing.carePlan.title;

    // Before the transaction, not after. Cleanup works from the sync links,
    // which point at the care events — once those are deleted there is nothing
    // left to tell Google which entry to withdraw, and the old time would sit
    // in the diary forever. Best-effort as always: a calendar that cannot be
    // reached must not stop an appointment being moved.
    if (rescheduled || leadsChanged) {
      await syncCalendar('cleanup', userId, existing.carePlanId);
    }

    await prisma.$transaction(async (tx: PrismaTx) => {
      await appointmentsRepository.update(
        appointmentId,
        personId,
        {
          ...(input.startsAt ? { startsAt: input.startsAt } : {}),
          ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}),
          ...(input.clinician !== undefined ? { clinician: input.clinician } : {}),
          ...(input.specialty !== undefined ? { specialty: input.specialty } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.reminderLeadMinutes ? { reminderLeadMinutes: leads } : {}),
        },
        tx,
      );

      if (input.title) {
        await tx.carePlan.update({
          where: { id: existing.carePlanId },
          data: { title: planTitle(input.title) },
        });
      }

      if (rescheduled || leadsChanged) {
        // Withdraw what was scheduled, then re-derive it. The reminders go
        // with the event by cascade, which is what should happen — a reminder
        // for a time that no longer exists has no business surviving in any
        // state, cancelled or otherwise.
        await appointmentsRepository.deleteEvents(existing.carePlanId, tx);

        await scheduleAppointmentEvent(
          existing.carePlanId,
          {
            title: planTitle(title),
            startsAt,
            leads,
            location: input.location ?? existing.location,
            clinician: input.clinician ?? existing.clinician,
          },
          tx,
        );
      }

      await careRepository.createActivityLog(
        {
          userId,
          personId,
          actorUserId: userId,
          type: rescheduled ? 'APPOINTMENT_RESCHEDULED' : 'APPOINTMENT_UPDATED',
          message: rescheduled
            ? `Appointment moved: ${planTitle(title)}`
            : `Appointment updated: ${planTitle(title)}`,
          metadata: { appointmentId, carePlanId: existing.carePlanId },
        },
        tx,
      );
    });

    log.info('Appointment updated', { userId, personId, appointmentId, rescheduled });

    if (rescheduled || leadsChanged) {
      // The old entry was withdrawn before the write; this lays down the new
      // one. Best-effort — it cannot undo a change already committed.
      await syncCalendar('prepare', userId, existing.carePlanId);
    }

    return appointmentsRepository.findForPerson(appointmentId, personId);
  },

  /**
   * Call one off.
   *
   * The row is kept and marked, never deleted: that an appointment was going
   * to happen is itself part of the record, and a cancelled one is often the
   * more clinically interesting fact. What does go is anything that would
   * still fire — reminders for a visit nobody is making, and the entry sitting
   * in someone's calendar.
   */
  async cancel(
    userId: string,
    appointmentId: string,
    reason?: string,
    requestedPersonId?: string,
  ) {
    const personId = await personAccess.resolveSubject(userId, requestedPersonId, 'write');

    const existing = await appointmentsRepository.findForPerson(appointmentId, personId);
    if (!existing) throw AppError.notFound('Appointment not found');
    if (existing.status === 'CANCELLED') {
      throw AppError.conflict('This appointment has already been cancelled');
    }

    await prisma.$transaction(async (tx: PrismaTx) => {
      await appointmentsRepository.update(
        appointmentId,
        personId,
        {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason: reason ?? null,
        },
        tx,
      );

      await appointmentsRepository.cancelPendingReminders(existing.carePlanId, tx);
      await appointmentsRepository.markPendingEvents(existing.carePlanId, 'SKIPPED', tx);

      // The plan is finished with, one way or another. Not PAUSED — see the
      // note at the top of this file.
      await careRepository.updateCarePlanStatus(existing.carePlanId, 'COMPLETED', tx);

      await careRepository.createActivityLog(
        {
          userId,
          personId,
          actorUserId: userId,
          type: 'APPOINTMENT_CANCELLED',
          message: `Appointment cancelled: ${existing.carePlan.title}`,
          metadata: { appointmentId, carePlanId: existing.carePlanId, reason: reason ?? null },
        },
        tx,
      );
    });

    log.info('Appointment cancelled', { userId, personId, appointmentId });

    await syncCalendar('cleanup', userId, existing.carePlanId);

    return appointmentsRepository.findForPerson(appointmentId, personId);
  },

  /**
   * Mark appointments nobody attended.
   *
   * Without this an appointment sits SCHEDULED for ever once its time has
   * passed, and every list of upcoming care keeps offering a visit that
   * happened last month — or did not.
   *
   * No access check, and deliberately so: this has no caller to authorize. It
   * runs on the worker over every Person in the system, which is exactly why
   * it does not take a userId — there is no account whose permissions would
   * mean anything here. What protects it instead is that it can only ever move
   * a row from "expected" to "missed", and touches nothing else.
   *
   * The claim and the transition are one statement, so running this on two
   * workers at once is safe: whichever gets there first takes the row, and the
   * other's filter no longer matches it.
   */
  async sweepMissed(
    options: { graceMs?: number; limit?: number } = {},
  ): Promise<{ missed: number }> {
    const graceMs = options.graceMs ?? env.APPOINTMENT_MISSED_GRACE_MS;
    const limit = options.limit ?? 200;

    const claimed = await appointmentsRepository.claimMissed(graceMs, limit);
    if (claimed.length === 0) return { missed: 0 };

    // Only the rows this worker actually took. Anything another worker claimed
    // is absent from `claimed` and is being settled by that worker.
    await appointmentsRepository.settlePlans(
      claimed.map((row) => row.carePlanId),
      'MISSED',
    );

    log.info('Appointments marked missed', { count: claimed.length });

    return { missed: claimed.length };
  },

  /** Mark one as having happened. */
  async complete(userId: string, appointmentId: string, requestedPersonId?: string) {
    const personId = await personAccess.resolveSubject(userId, requestedPersonId, 'write');

    const existing = await appointmentsRepository.findForPerson(appointmentId, personId);
    if (!existing) throw AppError.notFound('Appointment not found');
    if (existing.status === 'CANCELLED') {
      throw AppError.conflict('This appointment was cancelled');
    }

    await prisma.$transaction(async (tx: PrismaTx) => {
      await appointmentsRepository.update(
        appointmentId,
        personId,
        { status: 'COMPLETED', completedAt: new Date() },
        tx,
      );

      await appointmentsRepository.cancelPendingReminders(existing.carePlanId, tx);
      await appointmentsRepository.markPendingEvents(existing.carePlanId, 'DONE', tx);
      await careRepository.updateCarePlanStatus(existing.carePlanId, 'COMPLETED', tx);

      await careRepository.createActivityLog(
        {
          userId,
          personId,
          actorUserId: userId,
          type: 'APPOINTMENT_COMPLETED',
          message: `Appointment attended: ${existing.carePlan.title}`,
          metadata: { appointmentId, carePlanId: existing.carePlanId },
        },
        tx,
      );
    });

    log.info('Appointment completed', { userId, personId, appointmentId });

    return appointmentsRepository.findForPerson(appointmentId, personId);
  },
};
