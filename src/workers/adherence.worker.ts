import { Worker, Job } from 'bullmq';
import { env } from '@/config/env';
import { redisConnection } from '@/lib/redis';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  CheckMedicationAdherencePayload,
  notificationsQueue,
} from '@/queues/queue.registry';
import { prisma } from '@/lib/prisma';
import { recipientResolver } from '@/modules/care/recipient.resolver';
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
    const { reminderId, careEventId, personId, medicationName, scheduledFor } = payload;

    // Resolve the recipient now, not at enqueue. This job was delayed by half
    // an hour; the membership that justified it may have been revoked since.
    // `payload.userId` drains jobs enqueued before payloads carried a subject.
    const recipients = await recipientResolver.forPerson(personId, payload.userId);

    if (recipients.length === 0) {
      log.error('Adherence check has no eligible recipient', {
        reminderId,
        personId: personId ?? null,
      });

      await prisma.notificationAttempt
        .create({
          data: {
            reminderId,
            channel: 'EMAIL',
            type: 'FALLBACK_EMAIL',
            status: 'SKIPPED',
            idempotencyKey: `fallback:${reminderId}:none`,
            errorMessage: 'NO_ELIGIBLE_RECIPIENT',
          },
        })
        .catch(() => undefined);
      return;
    }

    const recipient = recipients[0];

    // The key names the resolved recipient. Two people must not share one key
    // — otherwise a handoff between enqueue and delivery would let the second
    // recipient's send be swallowed as a duplicate of the first's.
    const idempotencyKey = `fallback:${reminderId}:${recipient.id}`;

    const existingAttempt = await prisma.notificationAttempt.findUnique({
      where: { idempotencyKey },
    });

    if (existingAttempt) {
      log.info('Fallback already attempted for this reminder and recipient, skipping', {
        reminderId,
        recipientId: recipient.id,
      });
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
          idempotencyKey,
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
          idempotencyKey,
        },
      });

      // Create outbox event — worker will pick it up and send email
      await outboxRepository.create(
        {
          // The outbox row is owned by the account that will be emailed, so
          // erasure can null it. The payload carries the subject.
          userId: recipient.id,
          type: 'MEDICATION_FALLBACK_EMAIL',
          payload: {
            reminderId,
            personId: personId ?? undefined,
            medicationName,
            scheduledFor,
          },
        },
        tx,
      );
    });

    log.info('Fallback outbox event created', { reminderId, recipientId: recipient.id });
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
