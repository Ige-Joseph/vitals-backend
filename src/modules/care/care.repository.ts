import { prisma } from '@/lib/prisma';
import type { PrismaTx } from '@/types/prisma';
import { Prisma } from '@prisma/client';

export type CareEventStatusFilter = 'PENDING' | 'DONE' | 'SKIPPED' | 'MISSED';

/**
 * The subject a clinical query is scoped to. `personId` is required, not
 * optional — that is the whole point. Authorization happens before this via
 * assertPersonAccess; this type stops a scoped query being written unscoped.
 *
 * `userId` is the compatibility window, not a second authorization path. Rows
 * written before their module started dual-writing have `personId = NULL`, and
 * a strict person-only filter would make them silently disappear. Including
 * the account lets exactly those rows through — never a row that already
 * carries a different subject. It comes out when personId is NOT NULL.
 */
export interface PersonScope {
  personId: string;
  userId?: string;
}

/**
 * Scope for leaf clinical logs that carry their own personId. Same
 * compatibility window as carePlanScope: the subject's rows, plus rows not
 * yet backfilled that belong to the account — never a row already carrying a
 * different subject.
 */
export const personLogScope = (scope: PersonScope) => ({
  OR: [
    { personId: scope.personId },
    ...(scope.userId ? [{ personId: null, userId: scope.userId }] : []),
  ],
});

/** Matches the subject's rows, plus not-yet-backfilled rows of the account. */
export const carePlanScope = (scope: PersonScope) => ({
  OR: [
    { personId: scope.personId },
    ...(scope.userId ? [{ personId: null, userId: scope.userId }] : []),
  ],
});
/// Hand-maintained, and so able to drift from the enum in the schema — it
/// already had. Kept as a literal union rather than derived from Prisma
/// because every caller here depends on the narrowing, but it must be updated
/// whenever CarePlanType gains a value.
export type CarePlanType = 'MEDICATION' | 'PREGNANCY' | 'VACCINATION' | 'APPOINTMENT';

export interface CreateCarePlanInput {
  userId: string;
  /** The subject. Dual-written alongside userId during the compatibility window. */
  personId?: string;
  type: CarePlanType;
  title: string;
  metadata?: Prisma.InputJsonValue;
}

export interface CreateCareEventInput {
  carePlanId: string;
  eventType: string;
  title: string;
  description?: string;
  scheduledFor: Date;
  metadata?: Prisma.InputJsonValue;
}

export interface CreateReminderInput {
  careEventId: string;
  channel: 'PUSH' | 'EMAIL';
  sendAt: Date;
}

export const careRepository = {
  // ─── Care Plans ────────────────────────────────────────────────────────

  createCarePlan(data: CreateCarePlanInput, tx?: PrismaTx) {
    const client = tx ?? prisma;
    return client.carePlan.create({ data });
  },

  findCarePlan(id: string, userId: string) {
    return prisma.carePlan.findFirst({
      where: { id, userId },
    });
  },

  findActiveCarePlanByType(userId: string, type: CarePlanType) {
    return prisma.carePlan.findFirst({
      where: { userId, type, status: 'ACTIVE' },
    });
  },

  updateCarePlanStatus(
    id: string,
    status: 'ACTIVE' | 'PAUSED' | 'COMPLETED',
    tx?: PrismaTx,
  ) {
    const client = tx ?? prisma;
    return client.carePlan.update({ where: { id }, data: { status } });
  },

  // ─── Care Events ───────────────────────────────────────────────────────

  createCareEvent(data: CreateCareEventInput, tx?: PrismaTx) {
    const client = tx ?? prisma;
    return client.careEvent.create({ data });
  },

  createManyCareEvents(data: CreateCareEventInput[], tx?: PrismaTx) {
    const client = tx ?? prisma;
    return client.careEvent.createMany({ data, skipDuplicates: true });
  },

  

  findCareEvent(id: string) {
    return prisma.careEvent.findUnique({
      where: { id },
      include: { carePlan: true },
    });
  },

  findCareEventWithRelations(id: string) {
    return prisma.careEvent.findUnique({
      where: { id },
      include: {
        carePlan: {
          include: {
            medication: { select: { name: true } },
            user: {
              select: {
                id: true,
                email: true,
                profile: { select: { timezone: true } },
              },
            },
          },
        },
        reminders: true,
      },
    });
  },

  /**
   * Repository convention: a clinical query is never written without a person
   * scope. `PersonScope` makes that structural — the caller cannot express a
   * query for "everyone's care events" by accident, because there is no
   * overload that omits the subject.
   *
   * `userId` is still accepted alongside for the compatibility window. It is
   * not the authorization boundary any more; personId is.
   */
  listCareEvents(
    scope: PersonScope,
    filters: {
      status?: CareEventStatusFilter;
      type?: string;
      from?: Date;
      to?: Date;
      limit?: number;
    } = {},
  ) {
    return prisma.careEvent.findMany({
      where: {
        carePlan: { ...carePlanScope(scope), status: 'ACTIVE' },
        ...(filters.status && { status: filters.status }),
        ...(filters.type && { eventType: filters.type }),
        ...(filters.from || filters.to
          ? {
              scheduledFor: {
                ...(filters.from && { gte: filters.from }),
                ...(filters.to && { lte: filters.to }),
              },
            }
          : {}),
      },
      orderBy: { scheduledFor: 'asc' },
      ...(filters.limit !== undefined ? { take: filters.limit } : {}),
      include: { carePlan: { select: { type: true, title: true } } },
    });
  },

  updateCareEventStatus(
    id: string,
    status: 'PENDING' | 'DONE' | 'SKIPPED' | 'MISSED',
    tx?: PrismaTx,
  ) {
    const client = tx ?? prisma;
    return client.careEvent.update({ where: { id }, data: { status } });
  },

  getTodayCareEvents(scope: PersonScope) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    return prisma.careEvent.findMany({
      where: {
        carePlan: { ...carePlanScope(scope), status: 'ACTIVE' },
        scheduledFor: { gte: start, lte: end },
      },
      orderBy: { scheduledFor: 'asc' },
      include: { carePlan: { select: { type: true, title: true } } },
    });
  },

  getUpcomingCareEvents(scope: PersonScope, limit = 5) {
    return prisma.careEvent.findMany({
      where: {
        carePlan: { ...carePlanScope(scope), status: 'ACTIVE' },
        scheduledFor: { gt: new Date() },
        status: 'PENDING',
      },
      orderBy: { scheduledFor: 'asc' },
      take: limit,
      include: { carePlan: { select: { type: true, title: true } } },
    });
  },

  // ─── Mark missed events ────────────────────────────────────────────────

  markOverdueEventsMissed(cutoffMs: number) {
    const cutoff = new Date(Date.now() - cutoffMs);
    return prisma.careEvent.updateMany({
      where: {
        status: 'PENDING',
        scheduledFor: { lt: cutoff },
        carePlan: { status: 'ACTIVE' },
      },
      data: { status: 'MISSED' },
    });
  },

  // ─── Reminders ─────────────────────────────────────────────────────────

  createReminder(data: CreateReminderInput, tx?: PrismaTx) {
    const client = tx ?? prisma;
    return client.reminder.create({ data });
  },

  createManyReminders(data: CreateReminderInput[], tx?: PrismaTx) {
    const client = tx ?? prisma;
    return client.reminder.createMany({ data, skipDuplicates: true });
  },

  findDueReminders(limit = 100) {
    return prisma.reminder.findMany({
      where: {
        status: 'PENDING',
        sendAt: { lte: new Date() },
      },
      orderBy: { sendAt: 'asc' },
      take: limit,
      include: {
        careEvent: {
          include: {
            carePlan: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    profile: { select: { timezone: true } },
                  },
                },
                medication: { select: { name: true } },
              },
            },
          },
        },
      },
    });
  },

  claimReminder(id: string, tx?: PrismaTx) {
    const client = tx ?? prisma;
    return client.reminder.updateMany({
      where: {
        id,
        status: 'PENDING',
      },
      data: {
        status: 'PROCESSING',
        lastAttemptAt: new Date(),
      },
    });
  },

  cancelRemindersByCareEvent(careEventId: string, tx?: PrismaTx) {
    const client = tx ?? prisma;
    return client.reminder.updateMany({
      where: {
        careEventId,
        status: {
          in: ['PENDING', 'PROCESSING'],
        },
      },
      data: {
        status: 'CANCELLED',
        lastAttemptAt: new Date(),
      },
    });
  },

  updateReminderStatus(
    id: string,
    status: 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED',
    tx?: PrismaTx,
    errorMessage?: string,
  ) {
    const client = tx ?? prisma;

    const isTerminal =
      status === 'SENT' || status === 'FAILED' || status === 'CANCELLED';

    return client.reminder.update({
      where: { id },
      data: {
        status,
        lastAttemptAt: new Date(),
        ...(isTerminal ? { processedAt: new Date() } : {}),
        ...(status === 'FAILED'
          ? {
              retryCount: { increment: 1 },
              errorMessage: errorMessage ?? 'Reminder delivery failed',
            }
          : {}),
        ...(status !== 'FAILED'
          ? {
              errorMessage: null,
            }
          : {}),
      },
    });
  },

  // ─── Activity Log ──────────────────────────────────────────────────────

  createActivityLog(
    data: {
      userId: string;
      personId?: string;
      actorUserId?: string;
      type: string;
      message: string;
      metadata?: Prisma.InputJsonValue;
    },
    tx?: PrismaTx,
  ) {
    const client = tx ?? prisma;
    return client.activityLog.create({ data });
  },

  getRecentActivity(scope: PersonScope, limit = 10) {
    return prisma.activityLog.findMany({
      where: personLogScope(scope),
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },



  listEventsByCarePlan(carePlanId: string, scope: PersonScope) {
  return prisma.careEvent.findMany({
    where: {
      carePlanId,
      carePlan: carePlanScope(scope),
    },
    orderBy: { scheduledFor: 'desc' },
    include: {
      reminders: true,
      carePlan: {
        select: {
          id: true,
          type: true,
          title: true,
          status: true,
        },
      },
    },
  });
},


cancelRemindersByCarePlan(carePlanId: string, tx?: PrismaTx) {
  const client = tx ?? prisma;

  return client.reminder.updateMany({
    where: {
      careEvent: { carePlanId },
      status: { in: ['PENDING', 'PROCESSING'] },
    },
    data: {
      status: 'CANCELLED',
      lastAttemptAt: new Date(),
    },
  });
},

markPendingEventsSkippedByCarePlan(carePlanId: string, tx?: PrismaTx) {
  const client = tx ?? prisma;

  return client.careEvent.updateMany({
    where: {
      carePlanId,
      status: 'PENDING',
    },
    data: {
      status: 'SKIPPED',
    },
  });
},



  
};
