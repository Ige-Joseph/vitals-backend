import { Queue } from 'bullmq';
import { prisma } from '@/lib/prisma';
import { recipientResolver } from '@/modules/care/recipient.resolver';
import { outboxRepository } from '@/modules/outbox/outbox.repository';
import { careRepository } from '@/modules/care/care.repository';
import { adherenceQueue, JOB_NAMES } from '@/queues/queue.registry';
import { createLogger } from '@/lib/logger';

const log = createLogger('adherence-service');

const LIVE_JOB_STATES = new Set(['waiting', 'delayed', 'active', 'paused']);
const TERMINAL_JOB_STATES = new Set(['completed', 'failed']);

type AdherenceQueue = Pick<Queue, 'add' | 'getJob'>;

const adherenceJobOptions = (reminderId: string) => ({
  delay: 0,
  jobId: `adherence-${reminderId}`,
  attempts: 1,
});

export async function processAdherenceCheck(reminderId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.reminder.updateMany({
      where: {
        id: reminderId,
        adherenceCheckProcessedAt: null,
      },
      data: { adherenceCheckProcessedAt: new Date() },
    });

    if (claimed.count !== 1) return;

    const reminder = await tx.reminder.findUnique({
      where: { id: reminderId },
      include: {
        careEvent: {
          include: {
            carePlan: {
              select: {
                userId: true,
                personId: true,
                medication: { select: { name: true } },
              },
            },
          },
        },
      },
    });

    if (!reminder || reminder.status === 'CANCELLED' || !reminder.careEvent) return;

    const { careEvent } = reminder;
    const recipients = await recipientResolver.forPerson(
      careEvent.carePlan.personId ?? undefined,
      careEvent.carePlan.userId,
      tx,
    );

    if (recipients.length === 0) {
      await tx.notificationAttempt.createMany({
        data: [
          {
            reminderId,
            channel: 'EMAIL',
            type: 'FALLBACK_EMAIL',
            status: 'SKIPPED',
            idempotencyKey: `fallback:${reminderId}:none`,
            errorMessage: 'NO_ELIGIBLE_RECIPIENT',
          },
        ],
        skipDuplicates: true,
      });
      return;
    }

    const recipient = recipients[0];
    const idempotencyKey = `fallback:${reminderId}:${recipient.id}`;
    const existingAttempt = await tx.notificationAttempt.findUnique({
      where: { idempotencyKey },
      select: { id: true },
    });

    if (existingAttempt) return;

    const attempt = await tx.notificationAttempt.createMany({
      data: [
        {
          reminderId,
          channel: 'EMAIL',
          type: 'FALLBACK_EMAIL',
          status: careEvent.status === 'DONE' ? 'SKIPPED' : 'SENT',
          idempotencyKey,
        },
      ],
      skipDuplicates: true,
    });

    if (attempt.count !== 1) return;

    if (careEvent.status === 'DONE') return;

    await outboxRepository.create(
      {
        userId: recipient.id,
        type: 'MEDICATION_FALLBACK_EMAIL',
        payload: {
          reminderId,
          personId: careEvent.carePlan.personId ?? undefined,
          medicationName: careEvent.carePlan.medication?.name ?? 'medication',
          scheduledFor: careEvent.scheduledFor.toISOString(),
        },
      },
      tx,
    );
  });
}

export async function enqueueDueAdherenceCheck(
  queue: AdherenceQueue,
  reminderId: string,
): Promise<'enqueued' | 'skipped'> {
  const jobId = `adherence-${reminderId}`;
  const job = await queue.getJob(jobId);

  if (!job) {
    await queue.add(
      JOB_NAMES.CHECK_MEDICATION_ADHERENCE,
      { reminderId },
      adherenceJobOptions(reminderId),
    );
    return 'enqueued';
  }

  const state = await job.getState();
  if (LIVE_JOB_STATES.has(state)) return 'skipped';

  if (TERMINAL_JOB_STATES.has(state)) {
    await job.remove();
    await queue.add(
      JOB_NAMES.CHECK_MEDICATION_ADHERENCE,
      { reminderId },
      adherenceJobOptions(reminderId),
    );
    return 'enqueued';
  }

  return 'skipped';
}

export async function recoverDueAdherenceChecks(): Promise<void> {
  const rows = await careRepository.findDueAdherenceChecks();
  let enqueued = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const result = await enqueueDueAdherenceCheck(adherenceQueue, row.id);
      if (result === 'enqueued') enqueued += 1;
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }

  log.info('Adherence recovery scan complete', {
    found: rows.length,
    enqueued,
    skipped,
  });
}
