import { prisma } from '@/lib/prisma';
import type { PrismaTx } from '@/types/prisma';
import { Prisma } from '@prisma/client';

export type CareEventStatusFilter = 'PENDING' | 'DONE' | 'SKIPPED' | 'MISSED';
export type CarePlanType = 'MEDICATION' | 'PREGNANCY' | 'VACCINATION';

export interface CreateCarePlanInput {
  userId: string;
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

  listCareEvents(
    userId: string,
    filters: {
      status?: CareEventStatusFilter;
      type?: string;
      from?: Date;
      to?: Date;
    } = {},
  ) {
    return prisma.careEvent.findMany({
      where: {
        carePlan: { userId },
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

  getTodayCareEvents(userId: string) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    return prisma.careEvent.findMany({
      where: {
        carePlan: { userId, status: 'ACTIVE' },
        scheduledFor: { gte: start, lte: end },
      },
      orderBy: { scheduledFor: 'asc' },
      include: { carePlan: { select: { type: true, title: true } } },
    });
  },

  getUpcomingCareEvents(userId: string, limit = 5) {
    return prisma.careEvent.findMany({
      where: {
        carePlan: { userId, status: 'ACTIVE' },
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
    data: { userId: string; type: string; message: string; metadata?: Prisma.InputJsonValue; },
    tx?: PrismaTx,
  ) {
    const client = tx ?? prisma;
    return client.activityLog.create({ data });
  },

  getRecentActivity(userId: string, limit = 10) {
    return prisma.activityLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },
};