jest.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: jest.fn(),
  },
}));

jest.mock('@/modules/care/recipient.resolver', () => ({
  recipientResolver: { forPerson: jest.fn() },
}));

jest.mock('@/modules/outbox/outbox.repository', () => ({
  outboxRepository: { create: jest.fn() },
}));

jest.mock('@/queues/queue.registry', () => ({
  adherenceQueue: {},
  JOB_NAMES: { CHECK_MEDICATION_ADHERENCE: 'CHECK_MEDICATION_ADHERENCE' },
}));

import { prisma } from '@/lib/prisma';
import { recipientResolver } from '@/modules/care/recipient.resolver';
import { outboxRepository } from '@/modules/outbox/outbox.repository';
import {
  enqueueDueAdherenceCheck,
  processAdherenceCheck,
} from '@/modules/care/adherence.service';

const mockPrisma = prisma as any;
const mockResolver = recipientResolver as jest.Mocked<typeof recipientResolver>;
const mockOutbox = outboxRepository as jest.Mocked<typeof outboxRepository>;

const reminder = (status = 'PENDING') => ({
  id: 'rem-1',
  status: 'SENT',
  careEvent: {
    status,
    scheduledFor: new Date('2026-09-19T08:00:00.000Z'),
    carePlan: {
      userId: 'user-1',
      personId: 'person-1',
      medication: { name: 'Metformin' },
    },
  },
});

const recipient = { id: 'user-1', email: 'user@example.com', timezone: null };

let tx: any;

beforeEach(() => {
  jest.clearAllMocks();
  tx = {
    reminder: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(reminder()),
    },
    notificationAttempt: {
      findUnique: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  mockPrisma.$transaction.mockImplementation(async (callback: (client: any) => unknown) =>
    callback(tx),
  );
  mockResolver.forPerson.mockResolvedValue([recipient]);
  mockOutbox.create.mockResolvedValue({} as any);
});

describe('processAdherenceCheck', () => {
  it('claims DONE and records no fallback email', async () => {
    tx.reminder.findUnique.mockResolvedValue(reminder('DONE'));

    await processAdherenceCheck('rem-1');

    expect(tx.reminder.updateMany).toHaveBeenCalledWith({
      where: { id: 'rem-1', adherenceCheckProcessedAt: null },
      data: { adherenceCheckProcessedAt: expect.any(Date) },
    });
    expect(tx.notificationAttempt.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ status: 'SKIPPED' })],
      }),
    );
    expect(mockOutbox.create).not.toHaveBeenCalled();
  });

  it('preserves SKIPPED behavior by creating the fallback outbox event', async () => {
    tx.reminder.findUnique.mockResolvedValue(reminder('SKIPPED'));

    await processAdherenceCheck('rem-1');

    expect(mockOutbox.create).toHaveBeenCalledTimes(1);
  });

  it.each(['PENDING', 'MISSED'])('creates exactly one fallback for %s', async (status) => {
    tx.reminder.findUnique.mockResolvedValue(reminder(status));

    await processAdherenceCheck('rem-1');

    expect(tx.notificationAttempt.createMany).toHaveBeenCalledTimes(1);
    expect(mockOutbox.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing recipient', [], reminder()],
    ['cancelled reminder', [recipient], { ...reminder(), status: 'CANCELLED' }],
    ['deleted CareEvent', [recipient], { ...reminder(), careEvent: null }],
  ])('%s is claimed without sending email', async (_name, recipients, row) => {
    tx.reminder.findUnique.mockResolvedValue(row);
    mockResolver.forPerson.mockResolvedValue(recipients as any);

    await processAdherenceCheck('rem-1');

    expect(tx.reminder.updateMany).toHaveBeenCalled();
    expect(mockOutbox.create).not.toHaveBeenCalled();
  });

  it('is a no-op when another execution already processed the check', async () => {
    tx.reminder.updateMany.mockResolvedValue({ count: 0 });

    await processAdherenceCheck('rem-1');

    expect(tx.reminder.findUnique).not.toHaveBeenCalled();
    expect(mockResolver.forPerson).not.toHaveBeenCalled();
    expect(mockOutbox.create).not.toHaveBeenCalled();
  });

  it('quietly handles an existing NotificationAttempt', async () => {
    tx.notificationAttempt.findUnique.mockResolvedValue({ id: 'attempt-1' });

    await processAdherenceCheck('rem-1');

    expect(tx.reminder.updateMany).toHaveBeenCalled();
    expect(tx.notificationAttempt.createMany).not.toHaveBeenCalled();
    expect(mockOutbox.create).not.toHaveBeenCalled();
  });
});

describe('enqueueDueAdherenceCheck', () => {
  const queue = {
    getJob: jest.fn(),
    add: jest.fn(),
  } as any;

  beforeEach(() => jest.clearAllMocks());

  it('adds a runnable job when Redis has no job', async () => {
    queue.getJob.mockResolvedValue(undefined);

    await expect(enqueueDueAdherenceCheck(queue, 'rem-1')).resolves.toBe('enqueued');

    expect(queue.add).toHaveBeenCalledWith(
      'CHECK_MEDICATION_ADHERENCE',
      { reminderId: 'rem-1' },
      { delay: 0, jobId: 'adherence-rem-1', attempts: 1 },
    );
  });

  it.each(['waiting', 'delayed', 'active', 'paused'])(
    'does not duplicate a %s job',
    async (state) => {
      queue.getJob.mockResolvedValue({
        getState: jest.fn().mockResolvedValue(state),
        remove: jest.fn(),
      });

      await expect(enqueueDueAdherenceCheck(queue, 'rem-1')).resolves.toBe('skipped');
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it.each(['completed', 'failed'])('replaces a retained %s job', async (state) => {
    const remove = jest.fn().mockResolvedValue(undefined);
    queue.getJob.mockResolvedValue({ getState: jest.fn().mockResolvedValue(state), remove });

    await expect(enqueueDueAdherenceCheck(queue, 'rem-1')).resolves.toBe('enqueued');

    expect(remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
