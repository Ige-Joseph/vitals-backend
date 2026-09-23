/**
 * Replaces `@/queues/queue.registry` for database tests.
 *
 * The real module constructs BullMQ `Queue` instances at import time against
 * the Redis connection. Stubbing `@/lib/redis` alone is not enough — BullMQ
 * would still be handed an object it does not recognise. Names and job names
 * mirror the real registry so any code reading them behaves identically.
 *
 * Enqueued jobs are recorded rather than dispatched, so a test can assert that
 * a handler *tried* to queue work without a worker existing to run it.
 */

export const QUEUE_NAMES = {
  NOTIFICATIONS: 'notifications',
  ADHERENCE: 'adherence',
  OUTBOX: 'outbox',
  BILLING: 'billing',
  REPORTS: 'reports',
} as const;

export const JOB_NAMES = {
  SEND_VERIFICATION_EMAIL: 'SEND_VERIFICATION_EMAIL',
  SEND_PASSWORD_RESET_EMAIL: 'SEND_PASSWORD_RESET_EMAIL',
  SEND_PUSH_REMINDER: 'SEND_PUSH_REMINDER',
  SEND_MEDICATION_FALLBACK_EMAIL: 'SEND_MEDICATION_FALLBACK_EMAIL',
  SEND_MOOD_PROMPT_PUSH: 'SEND_MOOD_PROMPT_PUSH',
  CHECK_MEDICATION_ADHERENCE: 'CHECK_MEDICATION_ADHERENCE',
  PROCESS_OUTBOX_EVENT: 'PROCESS_OUTBOX_EVENT',
  PROCESS_BILLING_EVENT: 'PROCESS_BILLING_EVENT',
  GENERATE_HEALTH_SUMMARY: 'GENERATE_HEALTH_SUMMARY',
} as const;

export interface RecordedJob {
  queue: string;
  name: string;
  payload: unknown;
}

/** Every job any handler tried to enqueue during the current test. */
export const enqueuedJobs: RecordedJob[] = [];

export function clearEnqueuedJobs(): void {
  enqueuedJobs.length = 0;
}

function makeQueue(queue: string) {
  return {
    name: queue,
    async add(name: string, payload: unknown) {
      enqueuedJobs.push({ queue, name, payload });
      return { id: `stub-${enqueuedJobs.length}`, name, data: payload };
    },
    async close() {
      /* no-op */
    },
    async getJobs() {
      return [];
    },
    async getJob() {
      return undefined;
    },
  };
}

export const notificationsQueue = makeQueue(QUEUE_NAMES.NOTIFICATIONS);
export const adherenceQueue = makeQueue(QUEUE_NAMES.ADHERENCE);
export const outboxQueue = makeQueue(QUEUE_NAMES.OUTBOX);
export const billingQueue = makeQueue(QUEUE_NAMES.BILLING);
export const reportsQueue = makeQueue(QUEUE_NAMES.REPORTS);

export const closeQueues = async (): Promise<void> => {
  /* no-op */
};
