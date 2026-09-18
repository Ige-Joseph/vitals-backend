/**
 * Reminder dispatch: channel handling, push fallback, and payload shape.
 *
 * Prisma, the push provider and the outbox are mocked; the engine itself is
 * not. The assertions are about which branch the engine takes and what final
 * state it writes, which is exactly what the four fixes changed.
 */

jest.mock('@/lib/prisma', () => {
  const model = () => ({
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    deleteMany: jest.fn(),
    update: jest.fn(),
  });

  const client: any = {
    reminder: model(),
    pushToken: model(),
    notificationAttempt: model(),
    careEvent: model(),
  };

  client.$transaction = jest.fn(async (fn: any) => fn(client));
  return { prisma: client };
});

jest.mock('@/modules/care/care.repository', () => ({
  careRepository: {
    markOverdueEventsMissed: jest.fn(),
    findDueReminders: jest.fn(),
    claimReminder: jest.fn(),
    updateReminderStatus: jest.fn(),
    createActivityLog: jest.fn(),
  },
}));

jest.mock('@/modules/care/recipient.resolver', () => ({
  recipientResolver: { forCarePlan: jest.fn(), forPerson: jest.fn() },
}));

jest.mock('@/modules/outbox/outbox.repository', () => ({
  outboxRepository: { create: jest.fn() },
}));

jest.mock('@/providers/push/push.provider', () => ({
  pushProvider: { send: jest.fn(), sendToUserTokens: jest.fn() },
}));

jest.mock('@/queues/queue.registry', () => ({
  adherenceQueue: { add: jest.fn() },
  JOB_NAMES: { CHECK_MEDICATION_ADHERENCE: 'CHECK_MEDICATION_ADHERENCE' },
}));

jest.mock('@/lib/redis', () => ({
  redisConnection: { ping: jest.fn(), on: jest.fn(), disconnect: jest.fn() },
}));

import { prisma } from '@/lib/prisma';
import { careRepository } from '@/modules/care/care.repository';
import { recipientResolver } from '@/modules/care/recipient.resolver';
import { outboxRepository } from '@/modules/outbox/outbox.repository';
import { pushProvider } from '@/providers/push/push.provider';
import { adherenceQueue } from '@/queues/queue.registry';
import { reminderEngine, buildReminderPush } from '@/modules/care/reminder.engine';

const mockPrisma = prisma as any;
const mockRepo = careRepository as jest.Mocked<typeof careRepository>;
const mockResolver = recipientResolver as jest.Mocked<typeof recipientResolver>;
const mockOutbox = outboxRepository as jest.Mocked<typeof outboxRepository>;
const mockPush = pushProvider as jest.Mocked<typeof pushProvider>;

const RECIPIENT = { id: 'user-1', email: 'ada@example.com', timezone: 'Africa/Lagos' };

/** A reminder row as the engine re-reads it, parameterised by event type. */
const reminderRow = (overrides: {
  eventType?: string;
  channel?: string;
  person?: { id: string; displayName: string; ownerUserId: string | null } | null;
} = {}) => ({
  id: 'rem-1',
  channel: overrides.channel ?? 'PUSH',
  careEvent: {
    id: 'evt-1',
    status: 'PENDING',
    eventType: overrides.eventType ?? 'MEDICATION_DOSE',
    title: 'Take Metformin',
    description: '500mg',
    scheduledFor: new Date('2026-06-15T07:00:00.000Z'),
    carePlan: {
      id: 'plan-1',
      userId: 'user-1',
      personId: 'person-1',
      status: 'ACTIVE',
      medication: { name: 'Metformin' },
      person:
        overrides.person === undefined
          ? { id: 'person-1', displayName: 'Ada Okafor', ownerUserId: 'user-1' }
          : overrides.person,
    },
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRepo.claimReminder.mockResolvedValue({ count: 1 } as any);
  mockResolver.forCarePlan.mockResolvedValue([RECIPIENT]);
  mockPrisma.reminder.findUnique.mockResolvedValue(reminderRow());
  mockPrisma.pushToken.findMany.mockResolvedValue([{ id: 'tok-1', token: 'fcm-token' }]);
  mockPrisma.notificationAttempt.create.mockResolvedValue({});
  mockPrisma.pushToken.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
  mockPush.sendToUserTokens.mockResolvedValue({ sent: 1, failed: 0, invalidTokenIds: [] });
  mockOutbox.create.mockResolvedValue({} as any);
});

describe('1. push succeeds', () => {
  it.each(['MEDICATION_DOSE', 'ANC_VISIT', 'BABY_VACCINATION'])(
    'marks %s SENT and queues no fallback',
    async (eventType) => {
      mockPrisma.reminder.findUnique.mockResolvedValue(reminderRow({ eventType }));

      await reminderEngine.dispatchReminder({ id: 'rem-1' });

      expect(mockRepo.updateReminderStatus).toHaveBeenCalledWith(
        'rem-1',
        'SENT',
        expect.anything(),
      );
      expect(mockOutbox.create).not.toHaveBeenCalled();
    },
  );

  it('schedules the +30 minute adherence chase for medication only', async () => {
    await reminderEngine.dispatchReminder({ id: 'rem-1' });
    expect(adherenceQueue.add).toHaveBeenCalledTimes(1);
  });

  it.each(['ANC_VISIT', 'BABY_VACCINATION'])(
    'never schedules an adherence chase for %s',
    async (eventType) => {
      mockPrisma.reminder.findUnique.mockResolvedValue(reminderRow({ eventType }));

      await reminderEngine.dispatchReminder({ id: 'rem-1' });

      expect(adherenceQueue.add).not.toHaveBeenCalled();
    },
  );
});

describe('2. push fails, fallback succeeds', () => {
  it.each(['MEDICATION_DOSE', 'ANC_VISIT', 'BABY_VACCINATION'])(
    'queues a fallback email for %s and marks it SENT',
    async (eventType) => {
      mockPrisma.reminder.findUnique.mockResolvedValue(reminderRow({ eventType }));
      mockPrisma.pushToken.findMany.mockResolvedValue([]);

      await reminderEngine.dispatchReminder({ id: 'rem-1' });

      expect(mockOutbox.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'MEDICATION_FALLBACK_EMAIL',
          payload: expect.objectContaining({ eventType, reminderId: 'rem-1' }),
        }),
      );
      expect(mockRepo.updateReminderStatus).toHaveBeenCalledWith('rem-1', 'SENT');
    },
  );

  it('falls back when every token fails rather than only when none exist', async () => {
    mockPrisma.reminder.findUnique.mockResolvedValue(reminderRow({ eventType: 'ANC_VISIT' }));
    mockPush.sendToUserTokens.mockResolvedValue({
      sent: 0,
      failed: 2,
      invalidTokenIds: [],
    });

    await reminderEngine.dispatchReminder({ id: 'rem-1' });

    expect(mockOutbox.create).toHaveBeenCalled();
    expect(mockRepo.updateReminderStatus).toHaveBeenCalledWith('rem-1', 'SENT');
  });

  it('carries the event title so a non-medication email can be rendered', async () => {
    mockPrisma.reminder.findUnique.mockResolvedValue(reminderRow({ eventType: 'ANC_VISIT' }));
    mockPrisma.pushToken.findMany.mockResolvedValue([]);

    await reminderEngine.dispatchReminder({ id: 'rem-1' });

    expect(mockOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ title: 'Take Metformin' }),
      }),
    );
  });
});

describe('3. push fails and fallback fails', () => {
  it.each(['MEDICATION_DOSE', 'ANC_VISIT', 'BABY_VACCINATION'])(
    'marks %s FAILED with an actionable reason',
    async (eventType) => {
      mockPrisma.reminder.findUnique.mockResolvedValue(reminderRow({ eventType }));
      mockPrisma.pushToken.findMany.mockResolvedValue([]);
      mockOutbox.create.mockRejectedValue(new Error('outbox down'));

      await reminderEngine.dispatchReminder({ id: 'rem-1' });

      expect(mockRepo.updateReminderStatus).toHaveBeenCalledWith(
        'rem-1',
        'FAILED',
        undefined,
        expect.stringContaining('No FCM tokens available'),
      );
    },
  );
});

describe('4. no eligible recipient', () => {
  it('marks FAILED, records an attempt, and sends nothing', async () => {
    mockResolver.forCarePlan.mockResolvedValue([]);

    await reminderEngine.dispatchReminder({ id: 'rem-1' });

    expect(mockRepo.updateReminderStatus).toHaveBeenCalledWith(
      'rem-1',
      'FAILED',
      undefined,
      'NO_ELIGIBLE_RECIPIENT',
    );
    expect(mockPush.sendToUserTokens).not.toHaveBeenCalled();
    expect(mockOutbox.create).not.toHaveBeenCalled();
    expect(mockPrisma.notificationAttempt.create).toHaveBeenCalled();
  });
});

describe('unsupported channel — regression', () => {
  it('fails an EMAIL reminder explicitly instead of marking it SENT', async () => {
    mockPrisma.reminder.findUnique.mockResolvedValue(reminderRow({ channel: 'EMAIL' }));

    await reminderEngine.dispatchReminder({ id: 'rem-1' });

    expect(mockRepo.updateReminderStatus).toHaveBeenCalledWith(
      'rem-1',
      'FAILED',
      undefined,
      'UNSUPPORTED_CHANNEL:EMAIL',
    );
    expect(mockRepo.updateReminderStatus).not.toHaveBeenCalledWith('rem-1', 'SENT');
  });

  it('does not divert an unsupported channel into the email fallback', async () => {
    mockPrisma.reminder.findUnique.mockResolvedValue(reminderRow({ channel: 'EMAIL' }));

    await reminderEngine.dispatchReminder({ id: 'rem-1' });

    expect(mockOutbox.create).not.toHaveBeenCalled();
    expect(mockPush.sendToUserTokens).not.toHaveBeenCalled();
  });
});

describe('plan and event status are re-checked at dispatch', () => {
  it.each([
    ['a paused plan', { status: 'PAUSED' }, {}],
    ['a completed plan', { status: 'COMPLETED' }, {}],
    ['an event already done', {}, { status: 'DONE' }],
    ['an event already skipped', {}, { status: 'SKIPPED' }],
  ])('cancels the reminder for %s', async (_label, planPatch, eventPatch) => {
    const row = reminderRow();
    Object.assign(row.careEvent, eventPatch);
    Object.assign(row.careEvent.carePlan, planPatch);
    mockPrisma.reminder.findUnique.mockResolvedValue(row);

    await reminderEngine.dispatchReminder({ id: 'rem-1' });

    expect(mockRepo.updateReminderStatus).toHaveBeenCalledWith('rem-1', 'CANCELLED');
    expect(mockPush.sendToUserTokens).not.toHaveBeenCalled();
  });
});

describe('atomic claim', () => {
  it('does nothing when another worker already claimed the reminder', async () => {
    mockRepo.claimReminder.mockResolvedValue({ count: 0 } as any);

    await reminderEngine.dispatchReminder({ id: 'rem-1' });

    expect(mockPrisma.reminder.findUnique).not.toHaveBeenCalled();
    expect(mockPush.sendToUserTokens).not.toHaveBeenCalled();
    expect(mockRepo.updateReminderStatus).not.toHaveBeenCalled();
  });
});

describe('Person-aware notification payload', () => {
  const event = (person: any) => ({
    title: 'Take Metformin',
    description: '500mg',
    carePlan: { person },
  });

  it('leaves a self reminder exactly as it was', () => {
    const payload = buildReminderPush(
      event({ id: 'person-1', displayName: 'Ada Okafor', ownerUserId: 'user-1' }),
      'user-1',
    );

    expect(payload).toEqual({
      title: 'Take Metformin',
      body: '500mg',
      url: '/care',
    });
  });

  it('names the person on a reminder about someone else', () => {
    const payload = buildReminderPush(
      event({ id: 'person-2', displayName: 'Tunde Bello', ownerUserId: null }),
      'user-1',
    );

    expect(payload.title).toBe('Tunde Bello — Take Metformin');
  });

  it('deep-links to that person, not the recipient', () => {
    const payload = buildReminderPush(
      event({ id: 'person-2', displayName: 'Tunde Bello', ownerUserId: null }),
      'user-1',
    );

    expect(payload.url).toBe('/dashboard?personId=person-2');
  });

  it('distinguishes two managed persons under one account', () => {
    const father = buildReminderPush(
      event({ id: 'person-2', displayName: 'Tunde Bello', ownerUserId: null }),
      'user-1',
    );
    const baby = buildReminderPush(
      event({ id: 'person-3', displayName: 'Baby Bello', ownerUserId: null }),
      'user-1',
    );

    expect(father.title).not.toBe(baby.title);
    expect(father.url).not.toBe(baby.url);
  });

  it('treats a connected adult’s record as someone else’s', () => {
    // Owned by a different account — a connection, not a dependent.
    const payload = buildReminderPush(
      event({ id: 'person-4', displayName: 'Chioma Eze', ownerUserId: 'user-9' }),
      'user-1',
    );

    expect(payload.title).toBe('Chioma Eze — Take Metformin');
    expect(payload.url).toBe('/dashboard?personId=person-4');
  });

  it('falls back to the old shape for a plan with no person row', () => {
    const payload = buildReminderPush(event(null), 'user-1');

    expect(payload).toEqual({
      title: 'Take Metformin',
      body: '500mg',
      url: '/care',
    });
  });

  it('percent-encodes the id rather than interpolating it raw', () => {
    const payload = buildReminderPush(
      event({ id: 'a b&c', displayName: 'X', ownerUserId: null }),
      'user-1',
    );

    expect(payload.url).toBe('/dashboard?personId=a%20b%26c');
  });

  it('adds no clinical detail beyond what the event already carried', () => {
    const payload = buildReminderPush(
      event({ id: 'person-2', displayName: 'Tunde Bello', ownerUserId: null }),
      'user-1',
    );

    expect(payload.body).toBe('500mg');
  });
});
