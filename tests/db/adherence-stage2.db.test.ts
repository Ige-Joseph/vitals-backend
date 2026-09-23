import { prisma } from '@/lib/prisma';
import {
  processAdherenceCheck,
  recoverDueAdherenceChecks,
} from '@/modules/care/adherence.service';
import { outboxRepository } from '@/modules/outbox/outbox.repository';
import { createUser, type TestUser } from './helpers/factories';
import { clearEnqueuedJobs, enqueuedJobs } from './stubs/queues.stub';

const createCheck = async (
  user: TestUser,
  options: {
    eventStatus?: 'PENDING' | 'DONE' | 'SKIPPED' | 'MISSED';
    reminderStatus?: 'SENT' | 'CANCELLED';
    dueAt?: Date;
  } = {},
) => {
  const carePlan = await prisma.carePlan.create({
    data: {
      userId: user.id,
      personId: user.personId,
      type: 'MEDICATION',
      title: 'Metformin 500mg',
      status: 'ACTIVE',
      medication: {
        create: {
          name: 'Metformin',
          dosage: '500mg',
          frequency: 'ONCE_DAILY',
          startDate: new Date(),
        },
      },
    },
  });

  const careEvent = await prisma.careEvent.create({
    data: {
      carePlanId: carePlan.id,
      eventType: 'MEDICATION_DOSE',
      title: 'Take Metformin',
      scheduledFor: new Date(),
      status: options.eventStatus ?? 'PENDING',
    },
  });

  return prisma.reminder.create({
    data: {
      careEventId: careEvent.id,
      channel: 'PUSH',
      sendAt: new Date(),
      status: options.reminderStatus ?? 'SENT',
      adherenceCheckDueAt: options.dueAt ?? new Date(Date.now() - 10 * 60_000),
    },
  });
};

describe('durable adherence checks', () => {
  beforeEach(() => clearEnqueuedJobs());

  it('allows only one of two concurrent executions to claim the check', async () => {
    const user = await createUser();
    const reminder = await createCheck(user);

    await expect(
      Promise.all([
        processAdherenceCheck(reminder.id),
        processAdherenceCheck(reminder.id),
      ]),
    ).resolves.toEqual([undefined, undefined]);

    expect(
      await prisma.notificationAttempt.count({ where: { reminderId: reminder.id } }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { payload: { path: ['reminderId'], equals: reminder.id } },
      }),
    ).toBeLessThanOrEqual(1);
    expect(
      (await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } }))
        .adherenceCheckProcessedAt,
    ).toBeInstanceOf(Date);
  });

  it('commits the claim and quietly skips an existing NotificationAttempt', async () => {
    const user = await createUser();
    const reminder = await createCheck(user);

    await prisma.notificationAttempt.create({
      data: {
        reminderId: reminder.id,
        channel: 'EMAIL',
        type: 'FALLBACK_EMAIL',
        status: 'SENT',
        idempotencyKey: `fallback:${reminder.id}:${user.id}`,
      },
    });

    await expect(processAdherenceCheck(reminder.id)).resolves.toBeUndefined();

    const after = await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } });
    expect(after.adherenceCheckProcessedAt).toBeInstanceOf(Date);
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it('rolls back the claim when work after it fails', async () => {
    const user = await createUser();
    const reminder = await createCheck(user);
    const failure = jest
      .spyOn(outboxRepository, 'create')
      .mockRejectedValueOnce(new Error('forced adherence failure'));

    await expect(processAdherenceCheck(reminder.id)).rejects.toThrow('forced adherence failure');

    const after = await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } });
    expect(after.adherenceCheckProcessedAt).toBeNull();
    failure.mockRestore();
  });

  it('returns only due rows within the grace/lookback window, capped and ordered', async () => {
    const user = await createUser();
    const first = await createCheck(user);
    const event = await prisma.careEvent.findUniqueOrThrow({
      where: { id: first.careEventId },
    });
    const now = new Date();
    const validRows = Array.from({ length: 52 }, (_, index) => ({
      careEventId: event.id,
      channel: 'PUSH' as const,
      sendAt: now,
      status: 'SENT' as const,
      adherenceCheckDueAt: new Date(now.getTime() - 3 * 60_000 - index * 1000),
    }));
    await prisma.reminder.createMany({ data: validRows });

    await prisma.reminder.createMany({
      data: [
        {
          careEventId: event.id,
          channel: 'PUSH',
          sendAt: now,
          status: 'SENT',
          adherenceCheckDueAt: new Date(now.getTime() - 60_000),
        },
        {
          careEventId: event.id,
          channel: 'PUSH',
          sendAt: now,
          status: 'SENT',
          adherenceCheckDueAt: new Date(now.getTime() - 25 * 60 * 60_000),
        },
        {
          careEventId: event.id,
          channel: 'PUSH',
          sendAt: now,
          status: 'SENT',
          adherenceCheckDueAt: new Date(now.getTime() - 10 * 60_000),
          adherenceCheckProcessedAt: now,
        },
        {
          careEventId: event.id,
          channel: 'PUSH',
          sendAt: now,
          status: 'PENDING',
          adherenceCheckDueAt: new Date(now.getTime() - 10 * 60_000),
        },
      ],
    });

    const rows = await import('@/modules/care/care.repository').then(({ careRepository }) =>
      careRepository.findDueAdherenceChecks(now),
    );

    expect(rows).toHaveLength(50);
    expect(rows[0].adherenceCheckDueAt!.getTime()).toBeLessThanOrEqual(
      rows[rows.length - 1].adherenceCheckDueAt!.getTime(),
    );
    expect(rows.some((row) => row.id === first.id)).toBe(true);
  });

  it('simulates Redis loss: recovery enqueues and the worker processes the row', async () => {
    const user = await createUser();
    const reminder = await createCheck(user);

    await recoverDueAdherenceChecks();

    expect(enqueuedJobs).toEqual([
      expect.objectContaining({
        queue: 'adherence',
        name: 'CHECK_MEDICATION_ADHERENCE',
        payload: { reminderId: reminder.id },
      }),
    ]);

    await processAdherenceCheck(reminder.id);

    expect(await prisma.outboxEvent.count()).toBe(1);
    expect(
      (await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } }))
        .adherenceCheckProcessedAt,
    ).toBeInstanceOf(Date);
  });
});
