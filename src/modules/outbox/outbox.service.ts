import { outboxRepository } from './outbox.repository';
import {
  notificationsQueue,
  JOB_NAMES,
  SendVerificationEmailPayload,
  SendPasswordResetEmailPayload,
  SendMedicationFallbackEmailPayload,
} from '@/queues/queue.registry';
import { createLogger } from '@/lib/logger';

const log = createLogger('outbox-service');

export const outboxService = {
  /**
   * Called by the outbox poller job on a schedule.
   * Picks up PENDING events, enqueues BullMQ jobs, marks them PROCESSING.
   * The BullMQ worker marks them PROCESSED after successful send.
   */
  async processPending(): Promise<void> {
    await outboxRepository.resetStuck();

    const events = await outboxRepository.findPending(50);

    if (events.length === 0) return;

    log.info(`Processing ${events.length} pending outbox events`);

    for (const event of events) {
      try {
        await outboxRepository.markProcessing(event.id);

        switch (event.type) {
          case 'EMAIL_VERIFICATION': {
            const payload = event.payload as unknown as SendVerificationEmailPayload;

            await notificationsQueue.add(
              JOB_NAMES.SEND_VERIFICATION_EMAIL,
              {
                ...payload,
                outboxEventId: event.id,
              },
              {
                jobId: `verification-${event.id}`,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
              },
            );

            log.info('Enqueued verification email job', {
              outboxEventId: event.id,
              userId: event.userId,
            });

            break;
          }

          case 'MEDICATION_FALLBACK_EMAIL': {
            const payload = event.payload as unknown as SendMedicationFallbackEmailPayload;

            await notificationsQueue.add(
              JOB_NAMES.SEND_MEDICATION_FALLBACK_EMAIL,
              {
                ...payload,
                outboxEventId: event.id,
              },
              {
                jobId: `fallback-${event.id}`,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
              },
            );

            log.info('Enqueued medication fallback email job', {
              outboxEventId: event.id,
            });

            break;
          }

          case 'PASSWORD_RESET': {
            const payload = event.payload as unknown as SendPasswordResetEmailPayload;

            await notificationsQueue.add(
              JOB_NAMES.SEND_PASSWORD_RESET_EMAIL,
              {
                ...payload,
                outboxEventId: event.id,
              },
              {
                jobId: `password-reset-${event.id}`,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
              },
            );

            log.info('Enqueued password reset email job', {
              outboxEventId: event.id,
              userId: event.userId,
            });

            break;
          }

          default: {
            log.warn('Unhandled outbox event type', {
              type: event.type,
              id: event.id,
            });

            await outboxRepository.markFailed(
              event.id,
              `Unhandled type: ${event.type}`,
            );
          }
        }
      } catch (err: any) {
        log.error('Failed to enqueue outbox event', {
          outboxEventId: event.id,
          error: err.message,
        });

        await outboxRepository.markFailed(event.id, err.message);
      }
    }
  },
};