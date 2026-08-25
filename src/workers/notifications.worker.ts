import { Worker, Job } from 'bullmq';
import { redisConnection } from '@/lib/redis';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  SendVerificationEmailPayload,
  SendPasswordResetEmailPayload,
  SendMedicationFallbackEmailPayload,
} from '@/queues/queue.registry';
import { emailService } from '@/providers/email/email.service';
import { outboxRepository } from '@/modules/outbox/outbox.repository';
import { prisma } from '@/lib/prisma';
import { recipientResolver } from '@/modules/care/recipient.resolver';
import { createLogger } from '@/lib/logger';

const log = createLogger('notifications-worker');

export const notificationsWorker = new Worker(
  QUEUE_NAMES.NOTIFICATIONS,
  async (job: Job) => {
    log.info('Processing notification job', {
      jobId: job.id,
      jobName: job.name,
      attempt: job.attemptsMade + 1,
    });

    switch (job.name) {
      case JOB_NAMES.SEND_VERIFICATION_EMAIL: {
        const payload = job.data as SendVerificationEmailPayload;

        const user = await prisma.user.findUnique({
          where: { id: payload.userId },
          select: { email: true },
        });

        if (!user) {
          log.warn('User not found for verification email', { userId: payload.userId });
          await outboxRepository.markFailed(
            payload.outboxEventId,
            'User not found for verification email',
          );
          return;
        }

        await emailService.sendVerificationEmail({
          to: user.email,
          rawToken: payload.rawToken,
        });

        await outboxRepository.markProcessed(payload.outboxEventId);

        log.info('Verification email job complete', {
          jobId: job.id,
          userId: payload.userId,
        });
        break;
      }

      case JOB_NAMES.SEND_PASSWORD_RESET_EMAIL: {
        const payload = job.data as SendPasswordResetEmailPayload;

        const user = await prisma.user.findUnique({
          where: { id: payload.userId },
          select: { email: true, isActive: true },
        });

        if (!user) {
          log.warn('User not found for password reset email', { userId: payload.userId });
          await outboxRepository.markFailed(
            payload.outboxEventId,
            'User not found for password reset email',
          );
          return;
        }

        if (!user.isActive) {
          log.warn('Deactivated user cannot receive password reset email', {
            userId: payload.userId,
          });
          await outboxRepository.markFailed(
            payload.outboxEventId,
            'Deactivated user cannot receive password reset email',
          );
          return;
        }

        await emailService.sendPasswordResetEmail({
          to: user.email,
          rawToken: payload.rawToken,
        });

        await outboxRepository.markProcessed(payload.outboxEventId);

        log.info('Password reset email job complete', {
          jobId: job.id,
          userId: payload.userId,
        });
        break;
      }

      case JOB_NAMES.SEND_MEDICATION_FALLBACK_EMAIL: {
        const payload = job.data as SendMedicationFallbackEmailPayload & {
          outboxEventId: string;
        };

        // Resolve the address now. An email snapshot taken at enqueue goes
        // stale exactly as a userId does — the account may have been erased
        // since, which frees the address for someone else entirely.
        // `payload.userId`/`payload.email` drain the pre-change shape.
        const recipients = await recipientResolver.forPerson(
          payload.personId,
          payload.userId,
        );

        const to = recipients[0]?.email ?? payload.email;

        if (!to) {
          log.error('Medication fallback email has no eligible recipient', {
            jobId: job.id,
            reminderId: payload.reminderId,
            personId: payload.personId ?? null,
          });
          // Processed, not retried: retrying resolves to nobody again.
          await outboxRepository.markProcessed(payload.outboxEventId);
          break;
        }

        await emailService.sendMedicationFallbackEmail({
          to,
          medicationName: payload.medicationName,
          scheduledFor: payload.scheduledFor,
        });

        await outboxRepository.markProcessed(payload.outboxEventId);

        log.info('Medication fallback email job complete', {
          jobId: job.id,
          reminderId: payload.reminderId,
        });
        break;
      }

      default: {
        log.warn('Unknown job name in notifications worker', { jobName: job.name });
      }
    }
  },
  {
    connection: redisConnection,
    concurrency: 5,
  },
);

notificationsWorker.on('failed', async (job, err) => {
  log.error('Notification job failed', {
    jobId: job?.id,
    jobName: job?.name,
    attempt: job?.attemptsMade,
    error: err.message,
  });

  const outboxEventId = job?.data?.outboxEventId;
  if (outboxEventId) {
    await outboxRepository.markFailed(outboxEventId, err.message);
  }
});

notificationsWorker.on('completed', (job) => {
  log.debug('Notification job completed', { jobId: job.id, jobName: job.name });
});