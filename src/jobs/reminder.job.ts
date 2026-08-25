import { Queue, Worker, Job } from 'bullmq';
import { redisConnection } from '@/lib/redis';
import { reminderEngine } from '@/modules/care/reminder.engine';
import { outboxService } from '@/modules/outbox/outbox.service';
import { reconciliationService } from '@/modules/billing/reconciliation.service';
import { createLogger } from '@/lib/logger';
import { env } from '@/config/env';

const log = createLogger('reminder-job');

const REMINDER_QUEUE = 'reminder-scheduler';
const REMINDER_JOB = 'PROCESS_DUE_REMINDERS';
const RECONCILE_JOB = 'billing-reconcile';
const OUTBOX_JOB = 'PROCESS_OUTBOX';

// Dedicated queue for the scheduler — separate from the notifications queue
export const reminderSchedulerQueue = new Queue(REMINDER_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 50 },
  },
});

// Worker that processes the repeatable scheduler job
export const reminderSchedulerWorker = new Worker(
  REMINDER_QUEUE,
  async (job: Job) => {
    if (job.name === REMINDER_JOB) {
      log.debug('Reminder engine tick');
      await reminderEngine.processDueReminders();
    }

    if (job.name === OUTBOX_JOB) {
      log.debug('Outbox poller tick');
      await outboxService.processPending();
    }

    if (job.name === RECONCILE_JOB) {
      log.debug('Billing reconciliation tick');
      await reconciliationService.run();
    }
  },
  { connection: redisConnection, concurrency: 1 },
);

/**
 * Registers the repeatable jobs.
 * Call this once on worker startup — BullMQ deduplicates repeatable jobs by key.
 */
export const startScheduledJobs = async (): Promise<void> => {
  // Billing reconciliation — hourly by default. Webhooks are the fast path and
  // are not a guarantee; this is what notices when one was never delivered,
  // and what retries a cancellation the provider never confirmed.
  await reminderSchedulerQueue.add(
    RECONCILE_JOB,
    {},
    {
      repeat: { every: env.BILLING_RECONCILE_INTERVAL_MS },
      jobId: 'billing-reconcile-tick',
    },
  );

  // Reminder engine — every 60 seconds
  await reminderSchedulerQueue.add(
    REMINDER_JOB,
    {},
    {
      repeat: { every: 60_000 },
      jobId: 'reminder-engine-tick', // Stable ID prevents duplicates
    },
  );

  // Outbox poller — every 30 seconds
  await reminderSchedulerQueue.add(
    OUTBOX_JOB,
    {},
    {
      repeat: { every: 30_000 },
      jobId: 'outbox-poller-tick',
    },
  );

  log.info('Scheduled jobs registered', {
    jobs: ['reminder-engine (60s)', 'outbox-poller (30s)'],
  });
};

reminderSchedulerWorker.on('failed', (job, err) => {
  log.error('Scheduled job failed', {
    jobName: job?.name,
    error: err.message,
  });
});
