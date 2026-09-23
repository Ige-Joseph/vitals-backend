import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { truncateAll } from './setup/db-lifecycle';
import { createUser } from './helpers/factories';
import {
  planReconciliation,
  runReconciliation,
} from '@/modules/medications/schedule-reconciliation';

/**
 * The rehearsal gate for medication schedule reconciliation.
 *
 * Everything here runs against real Postgres with populated synthetic data,
 * because the thing being verified is a mutation: which rows change, which are
 * left alone, and whether ids survive. A mocked client would answer whatever it
 * was told and prove none of that.
 *
 * The population deliberately mixes what production mixes — two timezones, two
 * frequencies, custom dosing times, a DST boundary, history that must not move,
 * a second plan so occurrence matching has something to get wrong, and a plan
 * that is already correct so idempotence is observable on the first run.
 */

const clockAt = (instant: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);

const dateAt = (instant: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

/** Fixed "now" well before every future fixture, so eligibility is stable. */
const NOW = new Date('2026-06-01T00:00:00.000Z');

interface SeededEvent {
  id: string;
  reminderId: string | null;
  scheduledFor: Date;
}

const createPlan = async (options: {
  userId: string;
  personId: string;
  name: string;
  frequency: string;
  status?: 'ACTIVE' | 'COMPLETED';
}) => {
  const plan = await prisma.carePlan.create({
    data: {
      userId: options.userId,
      personId: options.personId,
      type: 'MEDICATION',
      title: `${options.name} — 500mg`,
      status: options.status ?? 'ACTIVE',
      metadata: { frequency: options.frequency },
      medication: {
        create: {
          name: options.name,
          dosage: '500mg',
          frequency: options.frequency,
          startDate: new Date('2026-06-01'),
          endDate: new Date('2027-06-01'),
        },
      },
    },
  });

  return plan.id;
};

const addDose = async (options: {
  carePlanId: string;
  scheduledFor: string;
  time: string;
  status?: 'PENDING' | 'DONE' | 'SKIPPED' | 'MISSED';
  withReminder?: boolean;
  leadMinutes?: number;
  eventType?: string;
  metadata?: Prisma.InputJsonValue;
}): Promise<SeededEvent> => {
  const scheduledFor = new Date(options.scheduledFor);

  const event = await prisma.careEvent.create({
    data: {
      carePlanId: options.carePlanId,
      eventType: options.eventType ?? 'MEDICATION_DOSE',
      title: 'Take Metformin',
      description: '500mg',
      scheduledFor,
      status: options.status ?? 'PENDING',
      metadata: options.metadata ?? { medicationName: 'Metformin', dosage: '500mg', time: options.time },
    },
  });

  let reminderId: string | null = null;

  if (options.withReminder !== false) {
    const lead = (options.leadMinutes ?? 0) * 60_000;
    const reminder = await prisma.reminder.create({
      data: {
        careEventId: event.id,
        channel: 'PUSH',
        sendAt: new Date(scheduledFor.getTime() - lead),
        status: 'PENDING',
      },
    });
    reminderId = reminder.id;
  }

  return { id: event.id, reminderId, scheduledFor };
};

describe('medication schedule reconciliation', () => {
  let lagos: Awaited<ReturnType<typeof createUser>>;
  let newYork: Awaited<ReturnType<typeof createUser>>;

  let lagosPlan: string;
  let lagosCustomPlan: string;
  let nyPlan: string;
  let completedPlan: string;
  let ancPlan: string;

  let lagosMorning: SeededEvent;
  let lagosEvening: SeededEvent;
  let lagosPast: SeededEvent;
  let lagosDone: SeededEvent;
  let lagosSkipped: SeededEvent;
  let lagosAlreadyCorrect: SeededEvent;
  let customEarly: SeededEvent;
  let customLate: SeededEvent;
  let nyBeforeDst: SeededEvent;
  let nyAfterDst: SeededEvent;
  let completedPlanEvent: SeededEvent;
  let ancEvent: SeededEvent;
  let noMetadataTime: SeededEvent;

  beforeAll(async () => {
    await truncateAll();

    lagos = await createUser({ email: 'lagos@test.local' });
    newYork = await createUser({ email: 'ny@test.local' });

    await prisma.profile.update({
      where: { userId: newYork.id },
      data: { timezone: 'America/New_York' },
    });

    lagosPlan = await createPlan({
      userId: lagos.id,
      personId: lagos.personId,
      name: 'Metformin',
      frequency: 'TWICE_DAILY',
    });

    lagosCustomPlan = await createPlan({
      userId: lagos.id,
      personId: lagos.personId,
      name: 'Lisinopril',
      frequency: 'TWICE_DAILY',
    });

    nyPlan = await createPlan({
      userId: newYork.id,
      personId: newYork.personId,
      name: 'Amlodipine',
      frequency: 'ONCE_DAILY',
    });

    completedPlan = await createPlan({
      userId: lagos.id,
      personId: lagos.personId,
      name: 'Ampiclox',
      frequency: 'ONCE_DAILY',
      status: 'COMPLETED',
    });

    ancPlan = (
      await prisma.carePlan.create({
        data: {
          userId: lagos.id,
          personId: lagos.personId,
          type: 'PREGNANCY',
          title: 'Pregnancy',
          status: 'ACTIVE',
        },
      })
    ).id;

    // ── Lagos user, doses written by a UTC server: one hour late ──
    lagosMorning = await addDose({
      carePlanId: lagosPlan,
      scheduledFor: '2026-07-10T08:00:00.000Z',
      time: '08:00',
    });
    lagosEvening = await addDose({
      carePlanId: lagosPlan,
      scheduledFor: '2026-07-10T20:00:00.000Z',
      time: '20:00',
    });

    // Past and non-pending rows that must not move.
    lagosPast = await addDose({
      carePlanId: lagosPlan,
      scheduledFor: '2026-05-10T08:00:00.000Z',
      time: '08:00',
      withReminder: false,
    });
    lagosDone = await addDose({
      carePlanId: lagosPlan,
      scheduledFor: '2026-07-11T08:00:00.000Z',
      time: '08:00',
      status: 'DONE',
    });
    lagosSkipped = await addDose({
      carePlanId: lagosPlan,
      scheduledFor: '2026-07-11T20:00:00.000Z',
      time: '20:00',
      status: 'SKIPPED',
    });

    // Already correct: 08:00 Lagos really is 07:00Z.
    lagosAlreadyCorrect = await addDose({
      carePlanId: lagosPlan,
      scheduledFor: '2026-07-12T07:00:00.000Z',
      time: '08:00',
    });

    // ── Custom dosing times, and a reminder with a non-zero lead ──
    customEarly = await addDose({
      carePlanId: lagosCustomPlan,
      scheduledFor: '2026-07-10T06:45:00.000Z',
      time: '06:45',
      leadMinutes: 30,
    });
    customLate = await addDose({
      carePlanId: lagosCustomPlan,
      scheduledFor: '2026-07-10T22:15:00.000Z',
      time: '22:15',
    });

    // ── New York, across the autumn DST boundary (1 Nov 2026) ──
    nyBeforeDst = await addDose({
      carePlanId: nyPlan,
      scheduledFor: '2026-10-30T08:00:00.000Z',
      time: '08:00',
    });
    nyAfterDst = await addDose({
      carePlanId: nyPlan,
      scheduledFor: '2026-11-03T08:00:00.000Z',
      time: '08:00',
    });

    // ── Rows outside scope entirely ──
    completedPlanEvent = await addDose({
      carePlanId: completedPlan,
      scheduledFor: '2026-07-10T08:00:00.000Z',
      time: '08:00',
    });
    ancEvent = await addDose({
      carePlanId: ancPlan,
      scheduledFor: '2026-07-10T08:00:00.000Z',
      time: '08:00',
      eventType: 'ANC_VISIT',
      metadata: { weekNumber: 20 },
    });

    // ── Unrecoverable: no wall clock persisted ──
    noMetadataTime = await addDose({
      carePlanId: lagosPlan,
      scheduledFor: '2026-07-13T08:00:00.000Z',
      time: '08:00',
      metadata: { medicationName: 'Metformin', dosage: '500mg' },
    });
  });

  afterAll(async () => {
    await truncateAll();
    await prisma.$disconnect();
  });

  // ────────────────────────────────────────────────────────────────
  // 10. Dry run performs zero writes
  // ────────────────────────────────────────────────────────────────

  describe('dry run', () => {
    it('writes nothing at all', async () => {
      const before = await prisma.careEvent.findMany({
        select: { id: true, scheduledFor: true, updatedAt: true },
        orderBy: { id: 'asc' },
      });
      const remindersBefore = await prisma.reminder.findMany({
        select: { id: true, sendAt: true },
        orderBy: { id: 'asc' },
      });

      const report = await runReconciliation({ dryRun: true, now: NOW });
      expect(report.applied).toBe(false);

      const after = await prisma.careEvent.findMany({
        select: { id: true, scheduledFor: true, updatedAt: true },
        orderBy: { id: 'asc' },
      });
      const remindersAfter = await prisma.reminder.findMany({
        select: { id: true, sendAt: true },
        orderBy: { id: 'asc' },
      });

      expect(after).toEqual(before);
      expect(remindersAfter).toEqual(remindersBefore);
    });

    it('reports the change set it would apply', async () => {
      const report = await planReconciliation({ now: NOW });

      // Eligible: 2 Lagos + 1 already-correct + 2 custom + 2 NY = 7,
      // plus the unrecoverable row = 8 loaded.
      expect(report.eligibleEvents).toBe(8);
      expect(report.eventsChanged).toBe(6);
      expect(report.eventsAlreadyCorrect).toBe(1);
      expect(report.skipped).toHaveLength(1);
      expect(report.skipped[0]).toMatchObject({
        careEventId: noMetadataTime.id,
        reason: 'NO_METADATA_TIME',
      });
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 1–4, 11. Correct rows change, to the correct values
  // ────────────────────────────────────────────────────────────────

  describe('apply', () => {
    beforeAll(async () => {
      await runReconciliation({ dryRun: false, now: NOW });
    });

    it('moves a Lagos dose to the right local clock time', async () => {
      const event = await prisma.careEvent.findUniqueOrThrow({
        where: { id: lagosMorning.id },
      });

      expect(event.scheduledFor.toISOString()).toBe('2026-07-10T07:00:00.000Z');
      expect(clockAt(event.scheduledFor, 'Africa/Lagos')).toBe('08:00');
      expect(dateAt(event.scheduledFor, 'Africa/Lagos')).toBe('2026-07-10');
    });

    it('moves the evening dose too, keeping its own wall clock', async () => {
      const event = await prisma.careEvent.findUniqueOrThrow({
        where: { id: lagosEvening.id },
      });

      expect(clockAt(event.scheduledFor, 'Africa/Lagos')).toBe('20:00');
      expect(dateAt(event.scheduledFor, 'Africa/Lagos')).toBe('2026-07-10');
    });

    it('uses the medication’s configured custom times, not the defaults', async () => {
      const early = await prisma.careEvent.findUniqueOrThrow({ where: { id: customEarly.id } });
      const late = await prisma.careEvent.findUniqueOrThrow({ where: { id: customLate.id } });

      expect(clockAt(early.scheduledFor, 'Africa/Lagos')).toBe('06:45');
      expect(clockAt(late.scheduledFor, 'Africa/Lagos')).toBe('22:15');
    });

    it('resolves New York either side of the DST boundary', async () => {
      const before = await prisma.careEvent.findUniqueOrThrow({ where: { id: nyBeforeDst.id } });
      const after = await prisma.careEvent.findUniqueOrThrow({ where: { id: nyAfterDst.id } });

      // The clock reading is identical; the UTC instant is not.
      expect(clockAt(before.scheduledFor, 'America/New_York')).toBe('08:00');
      expect(clockAt(after.scheduledFor, 'America/New_York')).toBe('08:00');

      expect(before.scheduledFor.toISOString()).toBe('2026-10-30T12:00:00.000Z'); // EDT
      expect(after.scheduledFor.toISOString()).toBe('2026-11-03T13:00:00.000Z'); // EST
    });

    it('leaves an already-correct dose exactly where it was', async () => {
      const event = await prisma.careEvent.findUniqueOrThrow({
        where: { id: lagosAlreadyCorrect.id },
      });

      expect(event.scheduledFor.getTime()).toBe(lagosAlreadyCorrect.scheduledFor.getTime());
    });

    // ── 2. History and out-of-scope rows are untouched ──

    it.each([
      ['a past pending dose', () => lagosPast],
      ['a DONE dose', () => lagosDone],
      ['a SKIPPED dose', () => lagosSkipped],
      ['an event on a completed plan', () => completedPlanEvent],
      ['an ANC event', () => ancEvent],
      ['an event with no recoverable time', () => noMetadataTime],
    ])('does not move %s', async (_label, getSeed) => {
      const seed = getSeed();
      const event = await prisma.careEvent.findUniqueOrThrow({ where: { id: seed.id } });

      expect(event.scheduledFor.getTime()).toBe(seed.scheduledFor.getTime());
    });

    // ── 4. Reminders follow, preserving their lead ──

    it('moves the reminder with its event when the lead is zero', async () => {
      const reminder = await prisma.reminder.findUniqueOrThrow({
        where: { id: lagosMorning.reminderId! },
      });

      expect(reminder.sendAt.toISOString()).toBe('2026-07-10T07:00:00.000Z');
    });

    it('preserves a non-zero reminder lead rather than assuming zero', async () => {
      const event = await prisma.careEvent.findUniqueOrThrow({ where: { id: customEarly.id } });
      const reminder = await prisma.reminder.findUniqueOrThrow({
        where: { id: customEarly.reminderId! },
      });

      expect(event.scheduledFor.getTime() - reminder.sendAt.getTime()).toBe(30 * 60_000);
    });

    // ── 5–8. Nothing created, nothing deleted, ids intact ──

    it('creates no new care events', async () => {
      const count = await prisma.careEvent.count();
      expect(count).toBe(13);
    });

    it('creates no new reminders', async () => {
      const count = await prisma.reminder.count();
      expect(count).toBe(12);
    });

    it('preserves every care event id', async () => {
      const ids = [
        lagosMorning, lagosEvening, lagosPast, lagosDone, lagosSkipped,
        lagosAlreadyCorrect, customEarly, customLate, nyBeforeDst, nyAfterDst,
        completedPlanEvent, ancEvent, noMetadataTime,
      ].map((e) => e.id);

      const found = await prisma.careEvent.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });

      expect(found).toHaveLength(ids.length);
    });

    it('preserves every reminder id', async () => {
      const ids = [
        lagosMorning, lagosEvening, lagosDone, lagosSkipped, lagosAlreadyCorrect,
        customEarly, customLate, nyBeforeDst, nyAfterDst, completedPlanEvent,
        ancEvent, noMetadataTime,
      ]
        .map((e) => e.reminderId)
        .filter((id): id is string => id !== null);

      const found = await prisma.reminder.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });

      expect(found).toHaveLength(ids.length);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 9. Idempotence
  // ────────────────────────────────────────────────────────────────

  describe('second run', () => {
    it('reports nothing left to change', async () => {
      const report = await planReconciliation({ now: NOW });

      expect(report.eventsChanged).toBe(0);
      expect(report.eventsAlreadyCorrect).toBe(7);
      expect(report.remindersChanged).toBe(0);
    });

    it('does not shift anything further when applied again', async () => {
      const before = await prisma.careEvent.findMany({
        select: { id: true, scheduledFor: true },
        orderBy: { id: 'asc' },
      });
      const remindersBefore = await prisma.reminder.findMany({
        select: { id: true, sendAt: true },
        orderBy: { id: 'asc' },
      });

      await runReconciliation({ dryRun: false, now: NOW });

      const after = await prisma.careEvent.findMany({
        select: { id: true, scheduledFor: true },
        orderBy: { id: 'asc' },
      });
      const remindersAfter = await prisma.reminder.findMany({
        select: { id: true, sendAt: true },
        orderBy: { id: 'asc' },
      });

      expect(after).toEqual(before);
      expect(remindersAfter).toEqual(remindersBefore);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Scoping to a single plan
  // ────────────────────────────────────────────────────────────────

  describe('--plan scoping', () => {
    it('loads only the named plan', async () => {
      const report = await planReconciliation({ carePlanId: nyPlan, now: NOW });

      expect(report.eligiblePlans).toBe(1);
      expect(report.entries.every((entry) => entry.carePlanId === nyPlan)).toBe(true);
    });
  });
});
