import { Queue } from 'bullmq';
import { redisConnection } from '@/lib/redis';

const defaultQueueOptions = {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
};

// ─────────────────────────────────────────────
// Queue names — single source of truth
// ─────────────────────────────────────────────
export const QUEUE_NAMES = {
  NOTIFICATIONS: 'notifications',
  ADHERENCE: 'adherence',
  OUTBOX: 'outbox',
  BILLING: 'billing',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ─────────────────────────────────────────────
// Job names — single source of truth
// ─────────────────────────────────────────────
export const JOB_NAMES = {
  // Notifications queue
  SEND_VERIFICATION_EMAIL: 'SEND_VERIFICATION_EMAIL',
  SEND_PASSWORD_RESET_EMAIL: 'SEND_PASSWORD_RESET_EMAIL',
  SEND_PUSH_REMINDER: 'SEND_PUSH_REMINDER',
  SEND_MEDICATION_FALLBACK_EMAIL: 'SEND_MEDICATION_FALLBACK_EMAIL',
  SEND_MOOD_PROMPT_PUSH: 'SEND_MOOD_PROMPT_PUSH',
  SEND_PERSON_INVITATION_EMAIL: 'SEND_PERSON_INVITATION_EMAIL',

  // Adherence queue
  CHECK_MEDICATION_ADHERENCE: 'CHECK_MEDICATION_ADHERENCE',

  // Outbox queue
  PROCESS_OUTBOX_EVENT: 'PROCESS_OUTBOX_EVENT',

  // Billing queue
  PROCESS_BILLING_EVENT: 'PROCESS_BILLING_EVENT',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

// ─────────────────────────────────────────────
// Job payload types
// ─────────────────────────────────────────────
export interface SendVerificationEmailPayload {
  outboxEventId: string;
  userId: string;
  email: string;
  rawToken: string;
}

/**
 * Addressed to an email, not to a user id. The recipient may have no account —
 * that is the case invitations exist for — so the address travels in the
 * payload rather than being looked up from a `userId` that would be null.
 */
export interface SendPersonInvitationEmailPayload {
  outboxEventId: string;
  email: string;
  rawToken: string;
  personDisplayName: string;
  inviterName: string;
  hasAccount: boolean;
  acceptUrl: string;
}

export interface SendPasswordResetEmailPayload {
  outboxEventId: string;
  userId: string;
  email: string;
  rawToken: string;
}

/**
 * Care-related payloads carry what the job is *about*, never who receives it.
 *
 * A recipient baked in at enqueue goes stale in more ways than one: a record
 * claimed, a membership revoked, an account deactivated or erased, ownership
 * handed over. Resolving late fixes all of them by construction, and matches
 * how dispatchReminder already works — it claims the reminder, then re-reads
 * fresh state before acting.
 *
 * The legacy fields below are read, never written. They exist so a worker can
 * drain jobs enqueued before this change; they come out after one release.
 */
export interface SendPushReminderPayload {
  reminderId: string;
  careEventId: string;
  personId: string;
  title: string;
  body: string;

  /** @deprecated Legacy enqueue shape. Read as a fallback, never written. */
  userId?: string;
}

export interface SendMedicationFallbackEmailPayload {
  reminderId: string;
  personId: string;
  medicationName: string;
  scheduledFor: string;

  /**
   * @deprecated Legacy enqueue shape. An email snapshot goes stale exactly
   * like a userId does — the address may have changed, or the account may
   * have been erased and the address freed for someone else.
   */
  userId?: string;
  email?: string;
}

export interface CheckMedicationAdherencePayload {
  reminderId: string;
  careEventId: string;
  personId: string;
  medicationName: string;
  scheduledFor: string;

  /** @deprecated Legacy enqueue shape. Read as a fallback, never written. */
  userId?: string;
  email?: string;
}

export interface ProcessOutboxEventPayload {
  outboxEventId: string;
}

/**
 * Carries the recorded event's id and nothing else.
 *
 * The provider's payload is already durable in the row; putting it in the job
 * too would give two copies that can disagree, and the row is the one that
 * survives a Redis flush.
 */
export interface ProcessBillingEventPayload {
  webhookEventId: string;
}

/**
 * Unchanged, and account-scoped on purpose. Prompting a caregiver about a
 * dependent's mood is not a coherent product action, so this asks an account
 * about itself.
 */
export interface SendMoodPromptPushPayload {
  userId: string;
}

// ─────────────────────────────────────────────
// Queue instances
// ─────────────────────────────────────────────
export const notificationsQueue = new Queue(QUEUE_NAMES.NOTIFICATIONS, defaultQueueOptions);
export const adherenceQueue = new Queue(QUEUE_NAMES.ADHERENCE, defaultQueueOptions);
export const outboxQueue = new Queue(QUEUE_NAMES.OUTBOX, defaultQueueOptions);
export const billingQueue = new Queue(QUEUE_NAMES.BILLING, defaultQueueOptions);

// Graceful shutdown helper
export const closeQueues = async () => {
  await Promise.all([
    notificationsQueue.close(),
    adherenceQueue.close(),
    outboxQueue.close(),
    billingQueue.close(),
  ]);
};