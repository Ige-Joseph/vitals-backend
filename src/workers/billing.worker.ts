import { Worker, Job } from 'bullmq';

import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { redisConnection } from '@/lib/redis';
import { createLogger } from '@/lib/logger';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  type ProcessBillingEventPayload,
} from '@/queues/queue.registry';
import { eventApplier } from '@/modules/billing/event.applier';

const log = createLogger('billing-worker');

/**
 * Applies recorded provider events.
 *
 * Intake already acknowledged the provider, so nothing here is on a request's
 * critical path — which is the point of splitting them. A failure retries with
 * backoff against a row that is already durable, so the provider never has to
 * resend for our benefit.
 */
export const billingWorker = new Worker(
  QUEUE_NAMES.BILLING,
  async (job: Job) => {
    if (job.name !== JOB_NAMES.PROCESS_BILLING_EVENT) {
      log.warn('Unknown job name in billing worker', { jobName: job.name });
      return;
    }

    const { webhookEventId } = job.data as ProcessBillingEventPayload;

    // Counted on the row rather than read off the job, because the row is what
    // outlives Redis. A queue flushed during a deploy takes its attempt counts
    // with it; the sweeper still has to be able to tell an event that has been
    // tried five times from one that has been tried once.
    const attempt = await prisma.billingWebhookEvent.update({
      where: { id: webhookEventId },
      data: { status: 'PROCESSING', retryCount: { increment: 1 } },
      select: { retryCount: true, providerEventId: true, type: true },
    });

    try {
      const outcome = await eventApplier.apply(webhookEventId);
      log.info('Billing event handled', { webhookEventId, outcome });
    } catch (err: any) {
      const exhausted = attempt.retryCount >= env.BILLING_EVENT_MAX_ATTEMPTS;

      // Recorded on the row as well as thrown, so a stuck event is visible in
      // the database rather than only in a queue dashboard.
      await prisma.billingWebhookEvent.update({
        where: { id: webhookEventId },
        data: {
          status: exhausted ? 'DEAD_LETTERED' : 'FAILED',
          error: err?.message ?? 'unknown error',
        },
      });

      if (exhausted) {
        // The loudest line this file has. Past this point nothing will retry
        // it on its own, and a billing event that never applied is money that
        // moved and state that did not follow.
        log.error('BILLING EVENT DEAD-LETTERED — needs a human', {
          webhookEventId,
          providerEventId: attempt.providerEventId,
          type: attempt.type,
          attempts: attempt.retryCount,
          error: err?.message,
        });
      }

      throw err;
    }
  },
  { connection: redisConnection, concurrency: 5 },
);

billingWorker.on('failed', (job, err) => {
  log.error('Billing job failed', { jobId: job?.id, error: err?.message });
});
