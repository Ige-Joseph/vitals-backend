import { Worker, Job } from 'bullmq';

import { redisConnection } from '@/lib/redis';
import { createLogger } from '@/lib/logger';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  type GenerateHealthSummaryPayload,
} from '@/queues/queue.registry';
import { reportsService } from '@/modules/reports/reports.service';

const log = createLogger('reports-worker');

/**
 * Renders health summaries.
 *
 * ── Concurrency is 1, and that is the point of this file ─────────────────
 *
 * Moving rendering off the request path does not by itself stop it competing
 * with requests: on the target instance the API and the workers are the same
 * Node process, sharing one event loop. What a queue buys is *serialisation* —
 * one document rendered at a time, rather than as many as happen to be asked
 * for at once.
 *
 * So this is deliberately the narrowest worker in the system. Two summaries
 * rendering together on a 1 GB box would contend for both memory and CPU, and
 * a long enough stall stops BullMQ renewing its job locks, at which point
 * healthy jobs start being reported as stalled and retried. One at a time,
 * behind a lower queue priority, keeps summaries out of the way of reminders
 * and billing — which are time-critical in a way a document nobody is waiting
 * on is not.
 */
export const reportsWorker = new Worker(
  QUEUE_NAMES.REPORTS,
  async (job: Job) => {
    if (job.name !== JOB_NAMES.GENERATE_HEALTH_SUMMARY) {
      log.warn('Unknown job name in reports worker', { jobName: job.name });
      return;
    }

    const { reportGenerationId } = job.data as GenerateHealthSummaryPayload;

    // The service claims the row conditionally and answers false when someone
    // else already has it. A replayed job is then a no-op rather than a second
    // rendering of the same health record.
    const rendered = await reportsService.renderPending(reportGenerationId);

    if (!rendered) {
      log.info('Report generation already claimed — nothing to do', {
        reportGenerationId,
      });
    }
  },
  { connection: redisConnection, concurrency: 1 },
);

reportsWorker.on('failed', (job, err) => {
  // The row carries its own failure reason, written before this fires, so a
  // reader is told what happened without anyone reading a queue dashboard.
  log.error('Report generation failed', {
    jobId: job?.id,
    attempts: job?.attemptsMade,
    error: err?.message,
  });
});
