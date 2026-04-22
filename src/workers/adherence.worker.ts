import { Worker, Job } from 'bullmq';
import { redisConnection } from '@/lib/redis';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  CheckMedicationAdherencePayload,
  notificationsQueue,
} from '@/queues/queue.registry';
import { prisma } from '@/lib/prisma';
import { outboxRepository } from '@/modules/outbox/outbox.repository';
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

    const payload = job.data as CheckMedicationAdherencePayload;
    const { reminderId, careEventId, userId, email, medicationName, scheduledFor } = payload;

    // Idempotency — check if fallback already attempted for this reminder
    const existingAttempt = await prisma.notificationAttempt.findUnique({
      where: { idempotencyKey: `fallback:${reminderId}` },
    });

    if (existingAttempt) {
      log.info('Fallback already attempted for reminder, skipping', { reminderId });
      return;
    }

    // Check if the medication was marked as taken
    const careEvent = await prisma.careEvent.findUnique({
      where: { id: careEventId },
      select: { status: true },
    });

    if (!careEvent) {
      log.warn('CareEvent not found in adherence check', { careEventId });
      return;
    }

    if (careEvent.status === 'DONE') {
      // User took their medication — no fallback needed
      log.info('Medication taken, no fallback needed', { careEventId, reminderId });

      await prisma.notificationAttempt.create({
        data: {
          reminderId,
          channel: 'EMAIL',
          type: 'FALLBACK_EMAIL',
          status: 'SKIPPED',
          idempotencyKey: `fallback:${reminderId}`,
        },
      });
      return;
    }

    // Medication not taken — create outbox event for fallback email
    // This keeps the fallback reliable via outbox pattern
    log.info('Medication not taken, creating fallback outbox event', {
      reminderId,
      careEventId,
    });

    await prisma.$transaction(async (tx) => {
      // Record the attempt
      await tx.notificationAttempt.create({
        data: {
          reminderId,
          channel: 'EMAIL',
          type: 'FALLBACK_EMAIL',
          status: 'SENT',
          idempotencyKey: `fallback:${reminderId}`,
        },
      });

      // Create outbox event — worker will pick it up and send email
      await outboxRepository.create(
        {
          userId,
          type: 'MEDICATION_FALLBACK_EMAIL',
          payload: {
            reminderId,
            userId,
            email,
            medicationName,
            scheduledFor,
          },
        },
        tx,
      );
    });

    log.info('Fallback outbox event created', { reminderId, userId });
  },
  {
    connection: redisConnection,
    concurrency: 3,
  },
);

adherenceWorker.on('failed', (job, err) => {
  log.error('Adherence job failed', {
    jobId: job?.id,
    attempt: job?.attemptsMade,
    error: err.message,
  });
});
