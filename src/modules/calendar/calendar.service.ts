import { CalendarSyncStatus } from '@prisma/client';

import { AppError } from '@/lib/errors';
import { jwtUtil } from '@/lib/jwt';
import { googleCalendarProvider } from '@/providers/calendar/google-calendar.provider';
import { calendarRepository } from './calendar.repository';
import { mapCareEventToGoogleEvent } from './calendar.mapper';


export const calendarService = {
  getGoogleConnectUrl(userId: string) {
    const state = jwtUtil.generateOAuthStateToken(userId);

    return {
      url: googleCalendarProvider.generateAuthUrl(state),
    };
  },

    async handleGoogleCallback(code: string, state: string) {
    const payload = jwtUtil.verifyOAuthStateToken(state);

    if (payload.type !== 'GOOGLE_CALENDAR_CONNECT') {
        throw AppError.badRequest('Invalid OAuth state');
    }

    const userId = payload.sub;

    const tokens = await googleCalendarProvider.exchangeCodeForTokens(code);

    if (!tokens.accessToken || !tokens.refreshToken || !tokens.expiryDate) {
        throw AppError.badRequest('Google did not return complete calendar tokens');
    }

    const accountEmail =
        await googleCalendarProvider.getAccountEmail(tokens.accessToken);

    await calendarRepository.upsertIntegration({
        userId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiryDate: tokens.expiryDate,
        accountEmail,
    });

    return {
        connected: true,
        accountEmail,
    };
    },

  async prepareCarePlanSync(userId: string, carePlanId: string) {
    const integration = await calendarRepository.findIntegration(userId);

    if (!integration) {
      throw AppError.badRequest('Google Calendar is not connected');
    }

    const events = await calendarRepository.findCareEventsByCarePlan(
      userId,
      carePlanId,
    );

    if (!events.length) {
      return { createdLinks: 0, totalEvents: 0, synced: 0, failed: 0, message: 'No pending care events to sync' };
    }

    const result = await calendarRepository.createPendingLinks(
      userId,
      events.map((event) => event.id),
    );

    const links = await calendarRepository.findLinksByCarePlan(userId, carePlanId);

    let synced = 0;
    let failed = 0;

    for (const link of links) {
      if (link.syncStatus !== CalendarSyncStatus.PENDING) continue;

      await calendarRepository.markLinkSyncing(link.id);

      try {
        const googleEvent = mapCareEventToGoogleEvent(link.careEvent);

        const created = await googleCalendarProvider.createEvent(
          {
            accessToken: integration.accessToken,
            refreshToken: integration.refreshToken,
            expiryDate: integration.expiryDate,
          },
          googleEvent,
        );

        await calendarRepository.markLinkSynced(link.id, created.externalEventId);
        synced += 1;
      } catch (error: any) {
        await calendarRepository.markLinkFailed(
          link.id,
          error.message ?? 'Google Calendar sync failed',
        );
        failed += 1;
      }
    }

    return {
      createdLinks: result.count,
      totalEvents: events.length,
      synced,
      failed,
    };
  },



    async cleanupCarePlanEvents(userId: string, carePlanId: string) {
    const integration = await calendarRepository.findIntegration(userId);

    if (!integration) {
        throw AppError.badRequest('Google Calendar is not connected');
    }

    const links = await calendarRepository.findSyncedLinksByCarePlan(
        userId,
        carePlanId,
    );

    let cleaned = 0;
    let failed = 0;

    for (const link of links) {
        if (!link.externalEventId) continue;

        try {
        await googleCalendarProvider.deleteEvent(
            {
            accessToken: integration.accessToken,
            refreshToken: integration.refreshToken,
            expiryDate: integration.expiryDate,
            },
            link.externalEventId,
        );

        await calendarRepository.markLinkCleanupResolved(link.id);
        cleaned += 1;
        } catch (error: any) {
        await calendarRepository.markLinkCleanupRequired(
            link.id,
            error.message ?? 'Google Calendar cleanup failed',
        );
        failed += 1;
        }
    }

    return {
        totalLinks: links.length,
        cleaned,
        failed,
    };
    },



    async getCalendarSyncSummary(userId: string) {
    const integration = await calendarRepository.findIntegration(userId);
    const rows = await calendarRepository.getSyncSummary(userId);

    const counts = rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.syncStatus] = row._count.syncStatus;
        return acc;
    }, {});

    return {
    connected: !!integration,
    accountEmail: integration?.accountEmail ?? null,
    failedSyncs:
        (counts.SYNC_FAILED ?? 0) + (counts.CLEANUP_REQUIRED ?? 0),
    ...counts,
    };
    },

    async retryFailedSyncs(userId: string) {
    const integration = await calendarRepository.findIntegration(userId);

    if (!integration) {
        throw AppError.badRequest('Google Calendar is not connected');
    }

    const links = await calendarRepository.findRetryableLinks(userId);

    let synced = 0;
    let failed = 0;

    for (const link of links) {
        await calendarRepository.markLinkSyncing(link.id);

        try {
        const googleEvent = mapCareEventToGoogleEvent(link.careEvent);

        const created = await googleCalendarProvider.createEvent(
            {
            accessToken: integration.accessToken,
            refreshToken: integration.refreshToken,
            expiryDate: integration.expiryDate,
            },
            googleEvent,
        );

        await calendarRepository.markLinkSynced(link.id, created.externalEventId);
        synced += 1;
        } catch (error: any) {
        await calendarRepository.markLinkFailed(
            link.id,
            error.message ?? 'Google Calendar retry failed',
        );
        failed += 1;
        }
    }

    return {
        total: links.length,
        synced,
        failed,
    };
    },

};