import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import {
  DEFAULT_TIMEZONE,
  isValidTimeZone,
  zonedWallClockToUtc,
} from '@/lib/timezone';

const log = createLogger('medication-reconciliation');

/**
 * Repairing medication doses that were materialised under server-local time.
 *
 * The scheduler now resolves "08:00" against the subject's zone, but a
 * medication plan writes up to a year of `CareEvent` rows the moment it is
 * created. Every plan made before that fix still holds future doses at the
 * wrong instant, and nothing in the running system will correct them.
 *
 * ── The identity problem, and why this is solvable ──────────────────────
 *
 * To recompute a dose you need the two things the user actually chose: the
 * calendar date and the wall-clock time. The time is persisted —
 * `CareEvent.metadata.time`, written by `buildDose` since the care engine was
 * introduced. The date is not persisted anywhere, and cannot be read off
 * `scheduledFor` without knowing which zone produced it.
 *
 * It can, however, be *derived*. The old code produced an instant whose
 * reading in the generating server's zone was exactly `metadata.time`. So the
 * generating offset is fixed by a single congruence:
 *
 *     offset ≡ (wall-clock minutes) − (UTC minutes of scheduledFor)   (mod 1440)
 *
 * Apply that offset to `scheduledFor` and the calendar date falls out. Nothing
 * is guessed and nothing depends on where this script runs.
 *
 * ── Where that derivation stops being safe ──────────────────────────────
 *
 * A congruence mod 1440 does not pin a single offset, because real zones span
 * −12:00 to +14:00 — a range of 1560 minutes, wider than a day. Two candidate
 * offsets exist precisely when the residue lands in [+12:00, +14:00], which is
 * also [−12:00, −10:00]. Such an event is genuinely ambiguous: it is not
 * possible to tell which calendar date the user meant.
 *
 * Those events are skipped and reported, never guessed. In practice the
 * residue is 0 (a UTC server) or +60 (a Lagos server), and the ambiguous band
 * requires the *generating* host to have been in the Pacific.
 *
 * ── Idempotence ─────────────────────────────────────────────────────────
 *
 * The target is always computed from (derived date, persisted wall-clock time,
 * current zone) and never from the existing timestamp, so nothing accumulates.
 * After a run the residue becomes the user's own offset, the derived date is
 * unchanged, and a second run computes the identical instant and writes
 * nothing.
 */

/** Real-world UTC offsets, in minutes. Etc/GMT-14 to Etc/GMT+12. */
const MIN_REAL_OFFSET_MINUTES = -720;
const MAX_REAL_OFFSET_MINUTES = 840;

const MINUTES_PER_DAY = 1440;

export interface OccurrenceIdentity {
  /** The wall-clock reading the user configured, e.g. "08:00". */
  time: string;
  /** The calendar date that reading belongs to, in the subject's own terms. */
  localDate: { year: number; month: number; day: number };
  /** Offset in force when the row was written, in minutes east of UTC. */
  generatedOffsetMinutes: number;
}

export type OccurrenceResolution =
  | { ok: true; identity: OccurrenceIdentity }
  | { ok: false; reason: 'NO_METADATA_TIME' | 'MALFORMED_TIME' | 'AMBIGUOUS_OFFSET' };

const parseWallClock = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;

  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
};

/**
 * Recover what the user asked for from what was stored.
 *
 * Reads only persisted fields — `metadata.time` and `scheduledFor` — so the
 * answer does not depend on the machine running this, nor on the machine that
 * wrote the row.
 */
export const resolveOccurrence = (event: {
  scheduledFor: Date;
  metadata: unknown;
}): OccurrenceResolution => {
  const metadata = (event.metadata ?? {}) as Record<string, unknown>;

  if (!('time' in metadata)) {
    return { ok: false, reason: 'NO_METADATA_TIME' };
  }

  const wantedMinutes = parseWallClock(metadata.time);
  if (wantedMinutes === null) {
    return { ok: false, reason: 'MALFORMED_TIME' };
  }

  const utcMinutes =
    event.scheduledFor.getUTCHours() * 60 + event.scheduledFor.getUTCMinutes();

  // The residue in [0, 1440). Every valid generating offset is congruent to it.
  const residue =
    (((wantedMinutes - utcMinutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  const candidates = [residue, residue - MINUTES_PER_DAY].filter(
    (offset) => offset >= MIN_REAL_OFFSET_MINUTES && offset <= MAX_REAL_OFFSET_MINUTES,
  );

  if (candidates.length !== 1) {
    // Either no real zone fits (impossible for a well-formed row) or two do,
    // and the calendar date differs between them. Not guessable.
    return { ok: false, reason: 'AMBIGUOUS_OFFSET' };
  }

  const generatedOffsetMinutes = candidates[0];

  // Shift into the generating zone's own reading, then take the date off it.
  const asGenerated = new Date(
    event.scheduledFor.getTime() + generatedOffsetMinutes * 60_000,
  );

  return {
    ok: true,
    identity: {
      time: `${String(Math.floor(wantedMinutes / 60)).padStart(2, '0')}:${String(
        wantedMinutes % 60,
      ).padStart(2, '0')}`,
      localDate: {
        year: asGenerated.getUTCFullYear(),
        month: asGenerated.getUTCMonth() + 1,
        day: asGenerated.getUTCDate(),
      },
      generatedOffsetMinutes,
    },
  };
};

/**
 * Where the dose belongs, given the subject's zone today.
 *
 * Delegates to the same helper the live scheduler uses. There is deliberately
 * no second DST algorithm here: if the two ever disagreed, reconciliation
 * would fight the scheduler forever.
 */
export const targetInstantFor = (
  identity: OccurrenceIdentity,
  timeZone: string,
): Date => {
  const [hour, minute] = identity.time.split(':').map(Number);
  return zonedWallClockToUtc({ ...identity.localDate, hour, minute }, timeZone);
};

export const resolveTimeZone = (raw: string | null | undefined): string => {
  const candidate = raw?.trim();
  if (!candidate || !isValidTimeZone(candidate)) return DEFAULT_TIMEZONE;
  return candidate;
};

export interface EventPlanEntry {
  careEventId: string;
  carePlanId: string;
  medicationName: string;
  timeZone: string;
  occurrenceKey: string;
  currentScheduledFor: Date;
  targetScheduledFor: Date;
  changes: boolean;
  reminders: Array<{
    reminderId: string;
    currentSendAt: Date;
    targetSendAt: Date;
    changes: boolean;
    /** Lead time preserved from the row rather than assumed to be zero. */
    leadMinutes: number;
  }>;
  /** Synced calendar links whose Google entry will be left at the old time. */
  syncedCalendarLinks: number;
}

/** Why an event was left alone. Never guessed, always reported. */
export type SkipReason =
  | 'NO_METADATA_TIME'
  | 'MALFORMED_TIME'
  | 'AMBIGUOUS_OFFSET'
  | 'DUPLICATE_OCCURRENCE';

export interface ReconciliationReport {
  eligiblePlans: number;
  eligibleEvents: number;
  eventsChanged: number;
  eventsAlreadyCorrect: number;
  remindersChanged: number;
  skipped: Array<{ careEventId: string; carePlanId: string; reason: SkipReason }>;
  calendarLinksNeedingResync: number;
  plansWithCalendarLinks: string[];
  entries: EventPlanEntry[];
  applied: boolean;
}

/**
 * Build the change set. Pure with respect to the database — it reads, decides,
 * and returns; nothing here writes. `runReconciliation` is what applies it.
 */
export const planReconciliation = async (options: {
  carePlanId?: string;
  now?: Date;
}): Promise<ReconciliationReport> => {
  const now = options.now ?? new Date();

  const plans = await prisma.carePlan.findMany({
    where: {
      type: 'MEDICATION',
      status: 'ACTIVE',
      ...(options.carePlanId ? { id: options.carePlanId } : {}),
    },
    select: {
      id: true,
      userId: true,
      medication: { select: { name: true } },
      user: { select: { profile: { select: { timezone: true } } } },
      careEvents: {
        // Narrow at the query, not in a filter afterwards: history must not
        // even be loaded, let alone considered.
        where: {
          eventType: 'MEDICATION_DOSE',
          status: 'PENDING',
          scheduledFor: { gt: now },
        },
        select: {
          id: true,
          scheduledFor: true,
          metadata: true,
          reminders: {
            where: { status: 'PENDING' },
            select: { id: true, sendAt: true },
          },
          calendarLinks: {
            where: { syncStatus: 'SYNCED' },
            select: { id: true },
          },
        },
        orderBy: { scheduledFor: 'asc' },
      },
    },
  });

  const report: ReconciliationReport = {
    eligiblePlans: 0,
    eligibleEvents: 0,
    eventsChanged: 0,
    eventsAlreadyCorrect: 0,
    remindersChanged: 0,
    skipped: [],
    calendarLinksNeedingResync: 0,
    plansWithCalendarLinks: [],
    entries: [],
    applied: false,
  };

  for (const plan of plans) {
    if (plan.careEvents.length === 0) continue;

    report.eligiblePlans += 1;
    report.eligibleEvents += plan.careEvents.length;

    const timeZone = resolveTimeZone(plan.user?.profile?.timezone);
    const medicationName = plan.medication?.name ?? 'medication';

    // One occurrence must map to one event. A collision means the derivation
    // produced the same logical slot twice, and neither can be trusted.
    const seen = new Map<string, string>();
    const planEntries: EventPlanEntry[] = [];
    const collided = new Set<string>();

    for (const event of plan.careEvents) {
      const resolution = resolveOccurrence(event);

      if (!resolution.ok) {
        report.skipped.push({
          careEventId: event.id,
          carePlanId: plan.id,
          reason: resolution.reason,
        });
        continue;
      }

      const { identity } = resolution;
      const { year, month, day } = identity.localDate;
      const occurrenceKey = `${plan.id}|${year}-${String(month).padStart(2, '0')}-${String(
        day,
      ).padStart(2, '0')}|${identity.time}`;

      const previous = seen.get(occurrenceKey);
      if (previous) {
        collided.add(occurrenceKey);
        report.skipped.push({
          careEventId: event.id,
          carePlanId: plan.id,
          reason: 'DUPLICATE_OCCURRENCE',
        });
        continue;
      }
      seen.set(occurrenceKey, event.id);

      const targetScheduledFor = targetInstantFor(identity, timeZone);
      const changes = targetScheduledFor.getTime() !== event.scheduledFor.getTime();

      const reminders = event.reminders.map((reminder) => {
        // Preserve whatever lead this reminder actually had rather than
        // assuming the medication constant. `reminderOffsetMinutes` is not a
        // column — it is stripped before the event is written — so the row
        // itself is the only record of it.
        const leadMs = event.scheduledFor.getTime() - reminder.sendAt.getTime();
        const targetSendAt = new Date(targetScheduledFor.getTime() - leadMs);

        return {
          reminderId: reminder.id,
          currentSendAt: reminder.sendAt,
          targetSendAt,
          changes: targetSendAt.getTime() !== reminder.sendAt.getTime(),
          leadMinutes: Math.round(leadMs / 60_000),
        };
      });

      planEntries.push({
        careEventId: event.id,
        carePlanId: plan.id,
        medicationName,
        timeZone,
        occurrenceKey,
        currentScheduledFor: event.scheduledFor,
        targetScheduledFor,
        changes,
        reminders,
        syncedCalendarLinks: event.calendarLinks.length,
      });
    }

    // A collision invalidates the first event of the pair too — it was only
    // recorded before the duplicate was seen.
    const usable = planEntries.filter((entry) => {
      if (!collided.has(entry.occurrenceKey)) return true;

      report.skipped.push({
        careEventId: entry.careEventId,
        carePlanId: entry.carePlanId,
        reason: 'DUPLICATE_OCCURRENCE',
      });
      return false;
    });

    for (const entry of usable) {
      if (entry.changes) {
        report.eventsChanged += 1;
        report.calendarLinksNeedingResync += entry.syncedCalendarLinks;

        if (entry.syncedCalendarLinks > 0 && !report.plansWithCalendarLinks.includes(plan.id)) {
          report.plansWithCalendarLinks.push(plan.id);
        }
      } else {
        report.eventsAlreadyCorrect += 1;
      }

      report.remindersChanged += entry.reminders.filter((r) => r.changes).length;
    }

    report.entries.push(...usable);
  }

  return report;
};

/**
 * Apply the change set, in place.
 *
 * Updates only `scheduledFor` and `sendAt` on rows that already exist. No row
 * is created and none is deleted, so every id survives and everything hanging
 * off these rows — reminders, calendar links, notification attempts, activity
 * history — keeps pointing at what it pointed at before.
 *
 * One transaction per plan rather than one for everything: a plan is the unit
 * a user experiences, a failure isolates to it, and a year of doses across
 * many plans in a single transaction is a lock nobody wants in production.
 */
export const runReconciliation = async (options: {
  dryRun: boolean;
  carePlanId?: string;
  now?: Date;
}): Promise<ReconciliationReport> => {
  const report = await planReconciliation({
    carePlanId: options.carePlanId,
    now: options.now,
  });

  if (options.dryRun) {
    log.info('Reconciliation dry run complete — no writes performed', {
      eligiblePlans: report.eligiblePlans,
      eligibleEvents: report.eligibleEvents,
      eventsChanged: report.eventsChanged,
      remindersChanged: report.remindersChanged,
      skipped: report.skipped.length,
    });
    return report;
  }

  const byPlan = new Map<string, EventPlanEntry[]>();
  for (const entry of report.entries) {
    if (!entry.changes && !entry.reminders.some((r) => r.changes)) continue;
    const list = byPlan.get(entry.carePlanId) ?? [];
    list.push(entry);
    byPlan.set(entry.carePlanId, list);
  }

  for (const [carePlanId, entries] of byPlan) {
    await prisma.$transaction(async (tx) => {
      for (const entry of entries) {
        if (entry.changes) {
          await tx.careEvent.update({
            where: { id: entry.careEventId },
            data: { scheduledFor: entry.targetScheduledFor },
          });
        }

        for (const reminder of entry.reminders) {
          if (!reminder.changes) continue;

          await tx.reminder.update({
            where: { id: reminder.reminderId },
            data: { sendAt: reminder.targetSendAt },
          });
        }
      }
    });

    log.info('Reconciled medication plan', {
      carePlanId,
      events: entries.filter((e) => e.changes).length,
      reminders: entries.reduce(
        (sum, e) => sum + e.reminders.filter((r) => r.changes).length,
        0,
      ),
    });
  }

  report.applied = true;
  return report;
};
