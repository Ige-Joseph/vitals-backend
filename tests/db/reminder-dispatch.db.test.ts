import { prisma } from '@/lib/prisma';
import { reminderEngine } from '@/modules/care/reminder.engine';
import { careRepository } from '@/modules/care/care.repository';
import { outboxRepository } from '@/modules/outbox/outbox.repository';
import { pushProvider } from '@/providers/push/push.provider';
// Imported by its own path rather than through `@/queues/queue.registry`:
// the moduleNameMapper rewrites that alias at runtime but TypeScript still
// checks it against the real registry, which has no `clearEnqueuedJobs`. Same
// resolved file either way, so the engine and this test share one instance.
import { clearEnqueuedJobs } from './stubs/queues.stub';
import { createUser, type TestUser } from './helpers/factories';

jest.mock('@/providers/push/push.provider', () => ({
  pushProvider: {
    sendToUserTokens: jest.fn(),
  },
}));

/**
 * The reminder engine actually claims and dispatches.
 *
 * This exists because of a specific production failure: the container ran
 * `dist/server.js`, which starts the HTTP API and nothing else. The repeatable
 * jobs — including the sixty-second reminder tick — are registered by
 * `worker.ts`, so nothing ever called `processDueReminders`. Reminders were
 * written correctly, came due correctly, and sat as PENDING rows for ever.
 *
 * Changing the entrypoint is not by itself evidence that the engine works;
 * nobody had ever watched it run. So this drives the engine directly against
 * real rows and asserts what it does to them: that a due reminder is claimed,
 * that dispatch is attempted, and that a second worker arriving at the same
 * reminder gets nothing.
 *
 * The delivery path taken here is the fallback one — an account with no FCM
 * token queues an email instead — which is deterministic and needs no
 * Firebase credentials, while still exercising claim, resolve-recipient,
 * dispatch and status write.
 */

const dueReminder = async (
  user: TestUser,
  minutesAgo = 5,
  eventType = 'MEDICATION_DOSE',
) => {
  const person = await prisma.person.findFirstOrThrow({
    where: { ownerUserId: user.id },
  });

  const carePlan = await prisma.carePlan.create({
    data: {
      userId: user.id,
      personId: person.id,
      type: 'MEDICATION',
      title: 'Amlodipine — 5mg',
      status: 'ACTIVE',
      medication: {
        create: {
          name: 'Amlodipine',
          dosage: '5mg',
          frequency: 'ONCE_DAILY',
          startDate: new Date(),
        },
      },
    },
  });

  const careEvent = await prisma.careEvent.create({
    data: {
      carePlanId: carePlan.id,
      eventType,
      title: 'Amlodipine 5mg',
      description: 'Time for your dose',
      scheduledFor: new Date(Date.now() + 30 * 60_000),
      status: 'PENDING',
    },
  });

  const reminder = await prisma.reminder.create({
    data: {
      careEventId: careEvent.id,
      channel: 'PUSH',
      // Already due. This is the state 595 rows were sitting in.
      sendAt: new Date(Date.now() - minutesAgo * 60_000),
      status: 'PENDING',
    },
  });

  return { carePlan, careEvent, reminder };
};

beforeEach(() => {
  clearEnqueuedJobs();
  (pushProvider.sendToUserTokens as jest.Mock).mockReset();
  (pushProvider.sendToUserTokens as jest.Mock).mockResolvedValue({
    sent: 1,
    failed: 0,
    invalidTokenIds: [],
  });
});

describe('a due reminder is claimed and dispatched', () => {
  it('does not leave it sitting PENDING', async () => {
    const user = await createUser();
    const { reminder } = await dueReminder(user);

    await reminderEngine.processDueReminders();

    const after = await prisma.reminder.findUniqueOrThrow({
      where: { id: reminder.id },
    });

    // The exact failure this guards: still PENDING means nothing ran.
    expect(after.status).not.toBe('PENDING');
    expect(after.status).toBe('SENT');
    expect(after.lastAttemptAt).toBeInstanceOf(Date);
  });

  it('hands the delivery on durably, as an outbox row', async () => {
    const user = await createUser();
    await dueReminder(user);

    await reminderEngine.processDueReminders();

    // No FCM token on this account, so the engine falls back to email. That
    // handoff is an outbox row rather than a queue job on purpose: the row is
    // written in the database the reminder lives in, so a process that dies
    // between claiming and enqueueing loses nothing — the poller picks it up.
    const outbox = await prisma.outboxEvent.findMany({
      where: { userId: user.id, type: 'MEDICATION_FALLBACK_EMAIL' },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].status).toBe('PENDING');
    expect((outbox[0].payload as Record<string, unknown>).medicationName).toBe('Amlodipine');

    const reminder = await prisma.reminder.findFirstOrThrow();
    expect(reminder.adherenceCheckDueAt).toBeNull();
    expect(reminder.adherenceCheckProcessedAt).toBeNull();
  });

  it('persists the adherence due time for a successful medication push', async () => {
    const user = await createUser();
    const { reminder } = await dueReminder(user);
    await prisma.pushToken.create({
      data: { userId: user.id, token: `token-${reminder.id}` },
    });

    const before = Date.now() + 1_800_000;
    await reminderEngine.processDueReminders();

    const after = await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } });
    expect(after.status).toBe('SENT');
    expect(after.adherenceCheckDueAt).toBeInstanceOf(Date);
    expect(after.adherenceCheckDueAt!.getTime()).toBeGreaterThanOrEqual(before - 2000);
    expect(after.adherenceCheckDueAt!.getTime()).toBeLessThanOrEqual(before + 2000);
    expect(after.adherenceCheckProcessedAt).toBeNull();
  });

  it('leaves the due time NULL for a non-medication push', async () => {
    const user = await createUser();
    const { reminder } = await dueReminder(user, 5, 'ANC_VISIT');
    await prisma.pushToken.create({
      data: { userId: user.id, token: `token-${reminder.id}` },
    });

    await reminderEngine.processDueReminders();

    const after = await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } });
    expect(after.status).toBe('SENT');
    expect(after.adherenceCheckDueAt).toBeNull();
    expect(after.adherenceCheckProcessedAt).toBeNull();
  });

  it('rolls back SENT and the due time when the activity log fails', async () => {
    const user = await createUser();
    const { reminder } = await dueReminder(user);
    await prisma.pushToken.create({
      data: { userId: user.id, token: `token-${reminder.id}` },
    });

    const activityLogFailure = jest
      .spyOn(careRepository, 'createActivityLog')
      .mockRejectedValueOnce(new Error('activity log unavailable'));
    const fallbackFailure = jest
      .spyOn(outboxRepository, 'create')
      .mockRejectedValueOnce(new Error('outbox unavailable'));

    await reminderEngine.processDueReminders();

    const after = await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } });
    expect(after.status).not.toBe('SENT');
    expect(after.adherenceCheckDueAt).toBeNull();
    expect(after.adherenceCheckProcessedAt).toBeNull();

    activityLogFailure.mockRestore();
    fallbackFailure.mockRestore();
  });

  it('has the durable adherence index in Postgres', async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'reminders'
        AND column_name IN ('adherenceCheckDueAt', 'adherenceCheckProcessedAt')
      ORDER BY column_name
    `;
    expect(columns.map((row) => row.column_name)).toEqual([
      'adherenceCheckDueAt',
      'adherenceCheckProcessedAt',
    ]);

    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'reminders'
        AND indexname = 'reminders_adherence_due_idx'
    `;
    expect(indexes).toHaveLength(1);
  });

  it('picks up everything already overdue, not just the newest', async () => {
    const user = await createUser();
    await dueReminder(user, 5);
    await dueReminder(user, 60);
    await dueReminder(user, 24 * 60);

    await reminderEngine.processDueReminders();

    const stuck = await prisma.reminder.count({ where: { status: 'PENDING' } });
    expect(stuck).toBe(0);
  });

  it('leaves a reminder that is not due yet alone', async () => {
    const user = await createUser();
    const { reminder } = await dueReminder(user, -60); // an hour from now

    await reminderEngine.processDueReminders();

    const after = await prisma.reminder.findUniqueOrThrow({
      where: { id: reminder.id },
    });
    expect(after.status).toBe('PENDING');
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it('cancels one whose care event is no longer pending', async () => {
    const user = await createUser();
    const { reminder, careEvent } = await dueReminder(user);

    // The dose was already marked taken before the reminder went out.
    await prisma.careEvent.update({
      where: { id: careEvent.id },
      data: { status: 'DONE' },
    });

    await reminderEngine.processDueReminders();

    const after = await prisma.reminder.findUniqueOrThrow({
      where: { id: reminder.id },
    });
    expect(after.status).toBe('CANCELLED');
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  /**
   * Two workers, one reminder.
   *
   * The deployment runs the scheduler in every worker process, so this is the
   * ordinary case rather than an edge one. The claim is a conditional update
   * on status, so the second caller updates zero rows and stops.
   */
  it('never dispatches the same reminder twice', async () => {
    const user = await createUser();
    const { reminder } = await dueReminder(user);

    await Promise.all([
      reminderEngine.dispatchReminder(reminder),
      reminderEngine.dispatchReminder(reminder),
    ]);

    // Exactly one handoff, from whichever caller won the claim.
    const outbox = await prisma.outboxEvent.findMany({
      where: { userId: user.id, type: 'MEDICATION_FALLBACK_EMAIL' },
    });
    expect(outbox).toHaveLength(1);

    const after = await prisma.reminder.findUniqueOrThrow({
      where: { id: reminder.id },
    });
    expect(after.status).toBe('SENT');
  });
});
