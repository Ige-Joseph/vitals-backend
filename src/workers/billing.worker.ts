import { Worker, Job } from 'bullmq';

import { prisma } from '@/lib/prisma';
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

    await prisma.billingWebhookEvent.update({
      where: { id: webhookEventId },
      data: { status: 'PROCESSING', retryCount: { increment: 1 } },
    });

    try {
      const outcome = await eventApplier.apply(webhookEventId);
      log.info('Billing event handled', { webhookEventId, outcome });
    } catch (err: any) {
      // Recorded on the row as well as thrown, so a stuck event is visible in
      // the database rather than only in a queue dashboard.
      await prisma.billingWebhookEvent.update({
        where: { id: webhookEventId },
        data: { status: 'FAILED', error: err?.message ?? 'unknown error' },
      });
      throw err;
    }
  },
  { connection: redisConnection, concurrency: 5 },
);

billingWorker.on('failed', (job, err) => {
  log.error('Billing job failed', { jobId: job?.id, error: err?.message });
});
