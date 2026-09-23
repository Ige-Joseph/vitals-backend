import { Prisma } from '@prisma/client';

import {
  FREQUENCY_DEFINITIONS,
  FrequencyKey,
  MAX_SCHEDULE_DAYS,
  MEDICATION_REMINDER_OFFSET_MINUTES,
} from '@/config/medication.config';
import { addDays, compareDateParts, zonedWallClockToUtc } from '@/lib/timezone';

export interface ScheduledDose {
  eventType: string;
  title: string;
  description: string;
  scheduledFor: Date;
  metadata: Prisma.InputJsonValue;
  reminderOffsetMinutes: number;
}

export interface GenerateScheduleInput {
  medicationName: string;
  dosage: string;
  frequency: FrequencyKey;
  startDate: Date;
  endDate: Date;
  customTimes?: string[];
  instructions?: string;
  /**
   * The zone the schedule is written in. "08:00" is a wall-clock reading, and
   * without a zone it is not yet a moment in time.
   *
   * Required rather than optional with a default: an omitted zone previously
   * meant "whatever the server is set to", which is how doses drifted by an
   * hour. Making callers name it means the question is answered where the
   * answer is known.
   */
  timeZone: string;
}

/**
 * Generates all scheduled dose events for a medication plan.
 * This includes past, current, and future doses so the app can keep
 * a complete medication history of PENDING, DONE, SKIPPED, or MISSED doses.
 *
 * Pure function — no DB calls. Driven entirely by medication.config.ts.
 */
export const generateMedicationSchedule = (input: GenerateScheduleInput): ScheduledDose[] => {
  const {
    medicationName,
    dosage,
    frequency,
    startDate,
    endDate,
    customTimes,
    instructions,
    timeZone,
  } = input;

  const definition = FREQUENCY_DEFINITIONS[frequency];
  const times = customTimes?.length ? customTimes : definition.defaultTimes;
  const doses: ScheduledDose[] = [];

  // The bounds arrive as YYYY-MM-DD parsed to UTC midnight, so their UTC
  // components *are* the calendar date the user chose. Reading them with local
  // getters would shift the date by a day for anyone behind UTC.
  const startParts = {
    year: startDate.getUTCFullYear(),
    month: startDate.getUTCMonth() + 1,
    day: startDate.getUTCDate(),
  };

  const endParts = {
    year: endDate.getUTCFullYear(),
    month: endDate.getUTCMonth() + 1,
    day: endDate.getUTCDate(),
  };

  // Clamp end date to MAX_SCHEDULE_DAYS from start. The day loop below is
  // inclusive of both ends, so the span is MAX_SCHEDULE_DAYS - 1 past the
  // start date -- adding the full count would schedule one day too many.
  const maxEnd = addDays(startParts, MAX_SCHEDULE_DAYS - 1);

  const effectiveEnd = compareDateParts(endParts, maxEnd) < 0 ? endParts : maxEnd;

  // Iterated as a calendar date, never as an instant. Adding 24 hours to a
  // timestamp lands on the wrong day when a DST transition falls in between;
  // adding one to the day number cannot.
  let current = startParts;

  while (compareDateParts(current, effectiveEnd) <= 0) {
    for (const time of times) {
      // Store all doses so history is complete
      doses.push(buildDose(current, time, timeZone, medicationName, dosage, instructions));
    }

    current = addDays(current, 1);
  }

  return doses;
};

const buildDose = (
  date: { year: number; month: number; day: number },
  time: string,
  timeZone: string,
  medicationName: string,
  dosage: string,
  instructions?: string,
): ScheduledDose => {
  const [hours, minutes] = time.split(':').map(Number);

  // The one line this whole fix is about: "08:00" is resolved against the
  // subject's zone on that calendar date, so the instant shifts across a DST
  // boundary while the clock reading the user set does not.
  const scheduledFor = zonedWallClockToUtc(
    { ...date, hour: hours, minute: minutes },
    timeZone,
  );

  return {
    eventType: 'MEDICATION_DOSE',
    title: `Take ${medicationName}`,
    description: [dosage, instructions].filter(Boolean).join(' — '),
    scheduledFor,
    metadata: { medicationName, dosage, time },
    reminderOffsetMinutes: MEDICATION_REMINDER_OFFSET_MINUTES,
  };
};