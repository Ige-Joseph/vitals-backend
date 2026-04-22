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

  // Adherence queue
  CHECK_MEDICATION_ADHERENCE: 'CHECK_MEDICATION_ADHERENCE',

  // Outbox queue
  PROCESS_OUTBOX_EVENT: 'PROCESS_OUTBOX_EVENT',
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

export interface SendPasswordResetEmailPayload {
  outboxEventId: string;
  userId: string;
  email: string;
  rawToken: string;
}

export interface SendPushReminderPayload {
  reminderId: string;
  careEventId: string;
  userId: string;
  title: string;
  body: string;
}

export interface SendMedicationFallbackEmailPayload {
  reminderId: string;
  userId: string;
  email: string;
  medicationName: string;
  scheduledFor: string;
}

export interface CheckMedicationAdherencePayload {
  reminderId: string;
  careEventId: string;
  userId: string;
  email: string;
  medicationName: string;
  scheduledFor: string;
}

export interface ProcessOutboxEventPayload {
  outboxEventId: string;
}

export interface SendMoodPromptPushPayload {
  userId: string;
}

// ─────────────────────────────────────────────
// Queue instances
// ─────────────────────────────────────────────
export const notificationsQueue = new Queue(QUEUE_NAMES.NOTIFICATIONS, defaultQueueOptions);
export const adherenceQueue = new Queue(QUEUE_NAMES.ADHERENCE, defaultQueueOptions);
export const outboxQueue = new Queue(QUEUE_NAMES.OUTBOX, defaultQueueOptions);

// Graceful shutdown helper
export const closeQueues = async () => {
  await Promise.all([
    notificationsQueue.close(),
    adherenceQueue.close(),
    outboxQueue.close(),
  ]);
};