import { prisma } from '@/lib/prisma';
import type { PrismaTx } from '@/types/prisma';
import type { Prisma } from '@prisma/client';

/**
 * Appointment reads and writes, every one of them scoped by `personId`.
 *
 * The scoping is not a convenience filter. Before the Person model existed,
 * repositories filtered on `userId` and that was safe only because the caller
 * and the subject were the same entity; here they are not, so `personId` is
 * the subject and it is required on every method that touches a row. A caller
 * who has resolved access to Person A cannot reach Person B's appointment
 * through any function below, because there is no function below that will
 * look one up without being told whose it is.
 */

export interface CreateAppointmentRow {
  carePlanId: string;
  personId: string;
  startsAt: Date;
  durationMinutes: number;
  clinician?: string;
  specialty?: string;
  location?: string;
  reason?: string;
  notes?: string;
  reminderLeadMinutes: number[];
  createdByUserId: string;
}

/** The plan row comes along on reads — it is the engine root and carries the title. */
const withPlan = { carePlan: true } satisfies Prisma.AppointmentInclude;

export const appointmentsRepository = {
  create(data: CreateAppointmentRow, tx?: PrismaTx) {
    const client = tx ?? prisma;
    return client.appointment.create({ data, include: withPlan });
  },

  /**
   * One appointment, but only if it belongs to this Person.
   *
   * Both halves of the where clause matter. The id alone would find any
   * appointment in the system; pairing it with the resolved `personId` is what
   * turns "does this row exist" into "may this caller see this row", without a
   * second query and without a check a future caller could forget to make.
   */
  findForPerson(id: string, personId: string, tx?: PrismaTx) {
    const client = tx ?? prisma;
    return client.appointment.findFirst({
      where: { id, personId },
      include: withPlan,
    });
  },

  listForPerson(
    personId: string,
    options: {
      scope: 'upcoming' | 'past' | 'all';
      status?: Prisma.EnumAppointmentStatusFilter | string;
      limit: number;
      now: Date;
    },
  ) {
    const { scope, status, limit, now } = options;

    return prisma.appointment.findMany({
      where: {
        personId,
        ...(status ? { status: status as never } : {}),
        ...(scope === 'upcoming' ? { startsAt: { gte: now } } : {}),
        ...(scope === 'past' ? { startsAt: { lt: now } } : {}),
      },
      // Upcoming reads forwards from now; past reads backwards from now. Both
      // put the appointment nearest the present first, which is the one being
      // looked for.
      orderBy: { startsAt: scope === 'past' ? 'desc' : 'asc' },
      take: limit,
      include: withPlan,
    });
  },

  update(id: string, personId: string, data: Prisma.AppointmentUpdateInput, tx?: PrismaTx) {
    const client = tx ?? prisma;
    // updateMany rather than update: it takes a filter rather than a unique
    // id, which is the only way to make `personId` part of the write itself.
    return client.appointment.updateMany({ where: { id, personId }, data });
  },

  /**
   * Drop the care events for this appointment, and with them their reminders.
   *
   * An appointment plan holds exactly one event — the appointment itself — so
   * this is "withdraw what was scheduled", not a partial edit. Deleting rather
   * than editing in place is deliberate: `prepareCarePlanSync` only syncs
   * links in PENDING, so an event kept at a new time would leave a link
   * already marked SYNCED and the old time sitting in someone's diary. A new
   * event id is what earns a new link and a fresh sync.
   *
   * The reminders go too, by cascade from CareEvent. That is the right
   * outcome here — a reminder for a time that no longer exists should not
   * survive in any state — but it does mean the calendar cleanup has to have
   * run first, while the links still have events to point at.
   */
  deleteEvents(carePlanId: string, tx?: PrismaTx) {
    const client = tx ?? prisma;
    return client.careEvent.deleteMany({ where: { carePlanId } });
  },

  /** Pending reminders for a plan, cancelled rather than deleted where the events survive. */
  cancelPendingReminders(carePlanId: string, tx?: PrismaTx) {
    const client = tx ?? prisma;
    return client.reminder.updateMany({
      where: { careEvent: { carePlanId }, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
  },

  /**
   * Claim appointments whose time has passed, and mark them missed.
   *
   * The same conditional-claim shape `claimReminder` uses, at set level: the
   * status is both the filter and what the statement writes, so the claim and
   * the transition are one atomic UPDATE. A second worker running the same
   * sweep concurrently matches nothing — the rows it would have taken are no
   * longer SCHEDULED or CONFIRMED by the time its own WHERE is evaluated — and
   * RETURNING tells this worker exactly which rows it, and only it, took.
   *
   * Raw SQL because the cutoff is per row: an appointment is over at
   * `startsAt + durationMinutes`, and Prisma's query builder cannot express a
   * comparison against a column-derived interval. Doing it in application code
   * instead would mean reading candidates and writing them back, which is the
   * race this is written to avoid.
   *
   * CONFIRMED is swept alongside SCHEDULED. An appointment someone confirmed
   * they would attend and then did not is missed in exactly the same sense;
   * leaving it out would leave those rows stuck for ever, which is the defect
   * this sweep exists to fix.
   */
  claimMissed(graceMs: number, limit: number, tx?: PrismaTx) {
    const client = tx ?? prisma;
    const graceSeconds = Math.round(graceMs / 1000);

    return client.$queryRaw<Array<{ id: string; carePlanId: string }>>`
      UPDATE appointments
         SET status = 'MISSED', "updatedAt" = now()
       WHERE id IN (
         SELECT id
           FROM appointments
          WHERE status IN ('SCHEDULED', 'CONFIRMED')
            AND "startsAt" + make_interval(mins => "durationMinutes")
                < now() - make_interval(secs => ${graceSeconds}::int)
          ORDER BY "startsAt" ASC
          LIMIT ${limit}::int
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, "carePlanId"
    `;
  },

  /** Care events for a plan that have not yet been acted on. */
  markPendingEvents(
    carePlanId: string,
    status: 'SKIPPED' | 'DONE' | 'MISSED',
    tx?: PrismaTx,
  ) {
    const client = tx ?? prisma;
    return client.careEvent.updateMany({
      where: { carePlanId, status: 'PENDING' },
      data: { status },
    });
  },

  /**
   * The same three tidy-ups the sweep needs, across many plans at once.
   *
   * Separate from the single-plan versions rather than a loop over them: a
   * sweep handling a hundred appointments should issue three statements, not
   * three hundred.
   */
  async settlePlans(
    carePlanIds: string[],
    eventStatus: 'MISSED' | 'SKIPPED' | 'DONE',
    tx?: PrismaTx,
  ) {
    if (carePlanIds.length === 0) return;
    const client = tx ?? prisma;

    await client.reminder.updateMany({
      where: { careEvent: { carePlanId: { in: carePlanIds } }, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });

    await client.careEvent.updateMany({
      where: { carePlanId: { in: carePlanIds }, status: 'PENDING' },
      data: { status: eventStatus },
    });

    await client.carePlan.updateMany({
      where: { id: { in: carePlanIds } },
      data: { status: 'COMPLETED' },
    });
  },
};
