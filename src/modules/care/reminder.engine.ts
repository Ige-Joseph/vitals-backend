import { prisma } from '@/lib/prisma';
import { careRepository } from '@/modules/care/care.repository';
import { outboxRepository } from '@/modules/outbox/outbox.repository';
import { pushProvider } from '@/providers/push/push.provider';
import { adherenceQueue, JOB_NAMES } from '@/queues/queue.registry';
import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';
import type { PrismaTx } from '@/types/prisma';

const log = createLogger('reminder-engine');

export const reminderEngine = {
  async processDueReminders(): Promise<void> {
    const missed = await careRepository.markOverdueEventsMissed(env.MISSED_WINDOW_MS);
    if ((missed as any).count > 0) {
      log.info('Marked overdue events as missed', { count: (missed as any).count });
    }

    const reminders = await careRepository.findDueReminders(100);
    if (reminders.length === 0) return;

    log.info(`Processing ${reminders.length} due reminders`);

    for (const reminder of reminders) {
      await reminderEngine.dispatchReminder(reminder);
    }
  },

  async dispatchReminder(reminder: any): Promise<void> {
    const reminderId = reminder.id;

    const claimed = await careRepository.claimReminder(reminderId);
    if (claimed.count === 0) {
      log.debug('Reminder already claimed or processed, skipping', { reminderId });
      return;
    }

    const freshReminder = await prisma.reminder.findUnique({
      where: { id: reminderId },
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

    if (!freshReminder) {
      log.warn('Claimed reminder no longer exists', { reminderId });
      return;
    }

    const careEvent = freshReminder.careEvent;
    const carePlan = careEvent.carePlan;
    const user = carePlan.user;

    if (carePlan.status !== 'ACTIVE' || careEvent.status !== 'PENDING') {
      await careRepository.updateReminderStatus(reminderId, 'CANCELLED');
      log.info('Reminder cancelled because event/plan is no longer active', {
        reminderId,
        careEventStatus: careEvent.status,
        carePlanStatus: carePlan.status,
      });
      return;
    }

    const medicationName = carePlan.medication?.name ?? 'medication';

    try {
      if (freshReminder.channel === 'PUSH') {
        await reminderEngine.sendPushReminder(freshReminder, user, careEvent, medicationName);
      } else {
        await careRepository.updateReminderStatus(reminderId, 'SENT');
      }
    } catch (err: any) {
      log.error('Failed to dispatch reminder', { reminderId, error: err.message });

      const fallbackQueued = await reminderEngine.tryQueueMedicationFallbackEmail(
        freshReminder,
        user,
        careEvent,
        medicationName,
        `Push dispatch error: ${err.message}`,
      );

      if (fallbackQueued) {
        await careRepository.updateReminderStatus(reminderId, 'SENT');
        return;
      }

      await careRepository.updateReminderStatus(
        reminderId,
        'FAILED',
        undefined,
        err.message,
      );
    }
  },

  async sendPushReminder(
    reminder: any,
    user: any,
    careEvent: any,
    medicationName: string,
  ): Promise<void> {
    const reminderId = reminder.id;

    const pushTokens = await prisma.pushToken.findMany({
      where: { userId: user.id },
      select: { id: true, token: true },
    });

    if (pushTokens.length === 0) {
      log.info('No FCM tokens for user — queueing fallback email', {
        userId: user.id,
        reminderId,
      });

      const fallbackQueued = await reminderEngine.tryQueueMedicationFallbackEmail(
        reminder,
        user,
        careEvent,
        medicationName,
        'No FCM tokens available',
      );

      if (fallbackQueued) {
        await careRepository.updateReminderStatus(reminderId, 'SENT');
        return;
      }

      await careRepository.updateReminderStatus(
        reminderId,
        'FAILED',
        undefined,
        'No FCM tokens available and fallback email could not be queued',
      );
      return;
    }

    const { sent, failed, invalidTokenIds } = await pushProvider.sendToUserTokens(
      pushTokens,
      {
        title: careEvent.title,
        body: careEvent.description ?? 'You have a care event due',
        url: '/care',
      },
    );

    if (invalidTokenIds.length > 0) {
      await prisma.pushToken.deleteMany({
        where: { id: { in: invalidTokenIds } },
      });

      log.info('Removed invalid FCM tokens', {
        count: invalidTokenIds.length,
        userId: user.id,
      });
    }

    log.info('Push reminder dispatched', { reminderId, sent, failed });

    if (sent > 0) {
      await prisma.$transaction(async (tx: PrismaTx) => {
        await careRepository.updateReminderStatus(reminderId, 'SENT', tx);

        await careRepository.createActivityLog(
          {
            userId: user.id,
            type: 'REMINDER_SENT',
            message: `Push reminder sent for: ${careEvent.title}`,
            metadata: { reminderId, sent, failed },
          },
          tx,
        );
      });

      if (careEvent.eventType === 'MEDICATION_DOSE') {
        await adherenceQueue.add(
          JOB_NAMES.CHECK_MEDICATION_ADHERENCE,
          {
            reminderId,
            careEventId: careEvent.id,
            userId: user.id,
            email: user.email,
            medicationName,
            scheduledFor: careEvent.scheduledFor.toISOString(),
          },
          {
            delay: env.ADHERENCE_CHECK_DELAY_MS,
            jobId: `adherence-${reminderId}`,
            attempts: 1,
          },
        );

        log.info('Adherence check scheduled', {
          reminderId,
          delayMs: env.ADHERENCE_CHECK_DELAY_MS,
        });
      }

      return;
    }

    const fallbackQueued = await reminderEngine.tryQueueMedicationFallbackEmail(
      reminder,
      user,
      careEvent,
      medicationName,
      `Push failed for all tokens (${failed} failures)`,
    );

    if (fallbackQueued) {
      await careRepository.updateReminderStatus(reminderId, 'SENT');
      return;
    }

    await careRepository.updateReminderStatus(
      reminderId,
      'FAILED',
      undefined,
      `Push failed for all tokens (${failed} failures)`,
    );
  },

  async tryQueueMedicationFallbackEmail(
    reminder: any,
    user: any,
    careEvent: any,
    medicationName: string,
    reason: string,
  ): Promise<boolean> {
    if (careEvent.eventType !== 'MEDICATION_DOSE') {
      return false;
    }

    try {
      await outboxRepository.create({
        userId: user.id,
        type: 'MEDICATION_FALLBACK_EMAIL',
        payload: {
          userId: user.id,
          email: user.email,
          reminderId: reminder.id,
          careEventId: careEvent.id,
          medicationName,
          title: careEvent.title,
          description: careEvent.description ?? null,
          scheduledFor: careEvent.scheduledFor.toISOString(),
          reason,
        },
      });

      log.info('Medication fallback email queued', {
        reminderId: reminder.id,
        userId: user.id,
        reason,
      });

      return true;
    } catch (err: any) {
      log.error('Failed to queue medication fallback email', {
        reminderId: reminder.id,
        userId: user.id,
        error: err.message,
      });

      return false;
    }
  },
};