import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { careRepository } from './care.repository';
import { createLogger } from '@/lib/logger';
import type { PrismaTx } from '@/types/prisma';
import { Prisma } from '@prisma/client';

const log = createLogger('care-service');

export const careService = {
  async listEvents(
    userId: string,
    filters: {
      status?: 'PENDING' | 'DONE' | 'SKIPPED' | 'MISSED';
      type?: string;
      from?: string;
      to?: string;
    },
  ) {
    return careRepository.listCareEvents(userId, {
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
    if (event.carePlan.userId !== userId) throw AppError.forbidden('Access denied');

    const updated = await prisma.$transaction(async (tx: PrismaTx) => {
      const updatedEvent = await careRepository.updateCareEventStatus(eventId, status, tx);

      if (status === 'DONE' || status === 'SKIPPED') {
        await careRepository.cancelRemindersByCareEvent(eventId, tx);
      }

      await careRepository.createActivityLog(
        {
          userId,
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
    for (const event of events) {
      const careEvent = await careRepository.createCareEvent(
        {
          carePlanId,
          eventType: event.eventType,
          title: event.title,
          description: event.description,
          scheduledFor: event.scheduledFor,
          metadata: event.metadata ?? {},
        },
        tx,
      );

      const offsetMs = (event.reminderOffsetMinutes ?? 15) * 60 * 1000;
      const sendAt = new Date(event.scheduledFor.getTime() - offsetMs);

      if (sendAt > new Date()) {
        await careRepository.createReminder(
          {
            careEventId: careEvent.id,
            channel: 'PUSH',
            sendAt,
          },
          tx,
        );
      }
    }

    log.info('Care events scheduled', {
      carePlanId,
      userId,
      count: events.length,
    });
  },
};