import {
  CalendarProvider,
  CalendarSyncStatus,
} from '@prisma/client';

import { prisma } from '@/lib/prisma';
import type { PrismaTx } from '@/types/prisma';

export const calendarRepository = {
  findIntegration(
    userId: string,
    provider: CalendarProvider = CalendarProvider.GOOGLE,
  ) {
    return prisma.calendarIntegration.findUnique({
      where: {
        userId_provider: { userId, provider },
      },
    });
  },

  findCareEventsByCarePlan(userId: string, carePlanId: string) {
    return prisma.careEvent.findMany({
      where: {
        carePlanId,
        carePlan: { userId },
        status: 'PENDING',
      },
      include: {
        carePlan: {
          select: {
            id: true,
            type: true,
            title: true,
            status: true,
            userId: true,
          },
        },
      },
      orderBy: { scheduledFor: 'asc' },
    });
  },

  createPendingLinks(
    userId: string,
    careEventIds: string[],
    provider: CalendarProvider = CalendarProvider.GOOGLE,
    tx?: PrismaTx,
  ) {
    const client = tx ?? prisma;

    return client.calendarEventLink.createMany({
      data: careEventIds.map((careEventId) => ({
        userId,
        careEventId,
        provider,
        syncStatus: CalendarSyncStatus.PENDING,
      })),
      skipDuplicates: true,
    });
  },

  findLinksByCarePlan(userId: string, carePlanId: string) {
    return prisma.calendarEventLink.findMany({
      where: {
        userId,
        careEvent: { carePlanId },
      },
      include: { careEvent: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  markLinkSyncing(id: string, tx?: PrismaTx) {
    const client = tx ?? prisma;

    return client.calendarEventLink.update({
      where: { id },
      data: {
        syncStatus: CalendarSyncStatus.SYNCING,
        lastSyncAttemptAt: new Date(),
        lastSyncError: null,
      },
    });
  },

  markLinkSynced(id: string, externalEventId: string, tx?: PrismaTx) {
    const client = tx ?? prisma;

    return client.calendarEventLink.update({
      where: { id },
      data: {
        syncStatus: CalendarSyncStatus.SYNCED,
        externalEventId,
        lastSyncAttemptAt: new Date(),
        lastSyncError: null,
      },
    });
  },

  markLinkFailed(id: string, error: string, tx?: PrismaTx) {
    const client = tx ?? prisma;

    return client.calendarEventLink.update({
      where: { id },
      data: {
        syncStatus: CalendarSyncStatus.SYNC_FAILED,
        lastSyncAttemptAt: new Date(),
        lastSyncError: error,
      },
    });
  },

  markCleanupRequired(careEventIds: string[], tx?: PrismaTx) {
    const client = tx ?? prisma;

    return client.calendarEventLink.updateMany({
      where: {
        careEventId: { in: careEventIds },
        syncStatus: CalendarSyncStatus.SYNCED,
        externalEventId: { not: null },
      },
      data: {
        syncStatus: CalendarSyncStatus.CLEANUP_REQUIRED,
        lastSyncAttemptAt: new Date(),
      },
    });
  },

  findFailedLinks(userId: string) {
    return prisma.calendarEventLink.findMany({
      where: {
        userId,
        syncStatus: {
          in: [
            CalendarSyncStatus.SYNC_FAILED,
            CalendarSyncStatus.PENDING,
          ],
        },
      },
      include: { careEvent: true },
    });
  },

  findCleanupRequiredLinks(userId: string) {
    return prisma.calendarEventLink.findMany({
      where: {
        userId,
        syncStatus: CalendarSyncStatus.CLEANUP_REQUIRED,
        externalEventId: { not: null },
      },
      include: { careEvent: true },
    });
  },


    upsertIntegration(data: {
    userId: string;
    accessToken: string;
    refreshToken: string;
    expiryDate: Date;
    provider?: CalendarProvider;
    accountEmail?: string | null;
    }) {
    return prisma.calendarIntegration.upsert({
        where: {
        userId_provider: {
            userId: data.userId,
            provider: data.provider ?? CalendarProvider.GOOGLE,
        },
        },
        update: {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiryDate: data.expiryDate,
        accountEmail: data.accountEmail,
        },
        create: {
        userId: data.userId,
        provider: data.provider ?? CalendarProvider.GOOGLE,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiryDate: data.expiryDate,
        accountEmail: data.accountEmail,
        },
    });
    },


    findSyncedLinksByCarePlan(userId: string, carePlanId: string) {
    return prisma.calendarEventLink.findMany({
        where: {
        userId,
        careEvent: { carePlanId },
        syncStatus: CalendarSyncStatus.SYNCED,
        externalEventId: { not: null },
        },
        include: { careEvent: true },
    });
    },

    markLinkCleanupResolved(id: string, tx?: PrismaTx) {
    const client = tx ?? prisma;

    return client.calendarEventLink.update({
        where: { id },
        data: {
        syncStatus: CalendarSyncStatus.CLEANUP_RESOLVED,
        lastSyncAttemptAt: new Date(),
        lastSyncError: null,
        },
    });
    },

    markLinkCleanupRequired(id: string, error: string, tx?: PrismaTx) {
    const client = tx ?? prisma;

    return client.calendarEventLink.update({
        where: { id },
        data: {
        syncStatus: CalendarSyncStatus.CLEANUP_REQUIRED,
        lastSyncAttemptAt: new Date(),
        lastSyncError: error,
        },
    });
    },




        getSyncSummary(userId: string) {
    return prisma.calendarEventLink.groupBy({
        by: ['syncStatus'],
        where: { userId },
        _count: { syncStatus: true },
    });
    },

    findRetryableLinks(userId: string) {
    return prisma.calendarEventLink.findMany({
        where: {
        userId,
        syncStatus: {
            in: [
            CalendarSyncStatus.PENDING,
            CalendarSyncStatus.SYNC_FAILED,
            ],
        },
        },
        include: { careEvent: true },
        orderBy: { updatedAt: 'desc' },
    });
    },
};