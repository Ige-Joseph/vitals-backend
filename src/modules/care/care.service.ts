import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { careRepository } from './care.repository';
import { personAccess } from '@/modules/person/person.access';
import { createLogger } from '@/lib/logger';
import type { PrismaTx } from '@/types/prisma';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';


const log = createLogger('care-service');

export const careService = {
  async listEvents(
    userId: string,
    filters: {
      status?: 'PENDING' | 'DONE' | 'SKIPPED' | 'MISSED';
      type?: string;
      from?: string;
      to?: string;
      personId?: string;
    },
  ) {
    // Resolve the subject and authorize before any clinical query runs. With
    // no personId supplied this is the caller's own record, which is how every
    // existing client continues to work unchanged.
    const personId = await personAccess.resolveSubject(userId, filters.personId, 'read');

    return careRepository.listCareEvents({ personId, userId }, {
      status: filters.status,
      type: filters.type,
      from: filters.from ? new Date(filters.from) : undefined,
      to: filters.to ? new Date(filters.to) : undefined,
    });
  },

  async updateEventStatus(
    userId: string,
    eventId: string,
    status: 'DONE' | 'SKIPPED' | 'PENDING',
  ) {
    const event = await careRepository.findCareEvent(eventId);
    if (!event) throw AppError.notFound('Care event not found');

    // This is the check the whole layer was generalised from. It used to read
    // `event.carePlan.userId !== userId`, which is only correct while caller
    // and subject are the same entity.
    if (event.carePlan.personId) {
      await personAccess.assertPersonAccess(userId, event.carePlan.personId, 'write');
    } else if (event.carePlan.userId !== userId) {
      // Compatibility: a plan whose subject has not been backfilled still
      // authorizes by account. Removable once personId is NOT NULL.
      throw AppError.forbidden('Access denied');
    }

    const updated = await prisma.$transaction(async (tx: PrismaTx) => {
      const updatedEvent = await careRepository.updateCareEventStatus(eventId, status, tx);

      if (status === 'DONE' || status === 'SKIPPED') {
        await careRepository.cancelRemindersByCareEvent(eventId, tx);
      }

      await careRepository.createActivityLog(
        {
          userId,
          // Dual-write. userId stays authoritative for the compatibility
          // window; personId is whose history this is, actorUserId is who did
          // it. Before separation those were the same account.
          personId: event.carePlan.personId ?? undefined,
          actorUserId: userId,
          type: 'CARE_EVENT_UPDATED',
          message: `${event.title} marked as ${status.toLowerCase()}`,
          metadata: { eventId, status, eventType: event.eventType },
        },
        tx,
      );

      return updatedEvent;
    });

    log.info('Care event status updated', { eventId, status, userId });
    return updated;
  },

    async scheduleEvents(
      carePlanId: string,
      userId: string,
      events: Array<{
        eventType: string;
        title: string;
        description?: string;
        scheduledFor: Date;
        metadata?: Prisma.InputJsonValue;
        reminderOffsetMinutes?: number;
      }>,
      tx?: PrismaTx,
    ): Promise<void> {
      const now = new Date();



      const careEvents = events.map((event) => ({
      id: randomUUID(),
      carePlanId,
      eventType: event.eventType,
      title: event.title,
      description: event.description,
      scheduledFor: event.scheduledFor,
      metadata: event.metadata ?? {},
      reminderOffsetMinutes: event.reminderOffsetMinutes ?? 0,
    }));

    await careRepository.createManyCareEvents(
      careEvents.map(({ reminderOffsetMinutes, ...event }) => event),
      tx,
    );

    const reminders = careEvents.reduce<
      Array<{ careEventId: string; channel: 'PUSH'; sendAt: Date }>
    >((acc, event) => {
      const offsetMs = event.reminderOffsetMinutes * 60 * 1000;
      const sendAt = new Date(event.scheduledFor.getTime() - offsetMs);

      

      if (sendAt > now) {
        acc.push({
          careEventId: event.id,
          channel: 'PUSH',
          sendAt,
        });
      }

      return acc;
    }, []);


    log.info('Reminder schedule debug', {
    now,
    reminders: reminders.map(r => ({
      careEventId: r.careEventId,
      sendAt: r.sendAt,
    })),
  });

      if (reminders.length > 0) {
        await careRepository.createManyReminders(reminders, tx);
      }

      log.info('Care events scheduled', {
        carePlanId,
        userId,
        count: careEvents.length,
        reminders: reminders.length,
      });
    },
  };