import { Worker, Job } from 'bullmq';
import { env } from '@/config/env';
import { redisConnection } from '@/lib/redis';
import { QUEUE_NAMES, JOB_NAMES } from '@/queues/queue.registry';
import { processAdherenceCheck } from '@/modules/care/adherence.service';
import { createLogger } from '@/lib/logger';

const log = createLogger('adherence-worker');

export const adherenceWorker = new Worker(
  QUEUE_NAMES.ADHERENCE,
  async (job: Job) => {
    log.info('Processing adherence check', {
      jobId: job.id,
      jobName: job.name,
    });

    if (job.name !== JOB_NAMES.CHECK_MEDICATION_ADHERENCE) {
      log.warn('Unknown job in adherence queue', { jobName: job.name });
      return;
    }

    const { reminderId } = job.data as { reminderId?: string };
    if (!reminderId) {
      log.warn('Adherence job has no reminderId', { jobId: job.id });
      return;
    }

    await processAdherenceCheck(reminderId);
  },
  {
    connection: redisConnection,
    concurrency: env.WORKER_CONCURRENCY_ADHERENCE,
  },
);

adherenceWorker.on('failed', (job, err) => {
  log.error('Adherence job failed', {
    jobId: job?.id,
    attempt: job?.attemptsMade,
    error: err.message,
  });
});
