import { Prisma } from '@prisma/client';

import {
  FREQUENCY_DEFINITIONS,
  FrequencyKey,
  MAX_SCHEDULE_DAYS,
  MEDICATION_REMINDER_OFFSET_MINUTES,
} from '@/config/medication.config';

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
  } = input;

  const definition = FREQUENCY_DEFINITIONS[frequency];
  const times = customTimes?.length ? customTimes : definition.defaultTimes;
  const doses: ScheduledDose[] = [];

  // Clamp end date to MAX_SCHEDULE_DAYS from start
  const maxEnd = new Date(startDate);
  maxEnd.setDate(maxEnd.getDate() + MAX_SCHEDULE_DAYS);

  const effectiveEnd = endDate < maxEnd ? endDate : maxEnd;

  const current = new Date(startDate);
  current.setHours(0, 0, 0, 0);

  while (current <= effectiveEnd) {
    for (const time of times) {
      const dose = buildDose(new Date(current), time, medicationName, dosage, instructions);

      // Store all doses so history is complete
      doses.push(dose);
    }

    current.setDate(current.getDate() + 1);
  }

  return doses;
};

const buildDose = (
  date: Date,
  time: string,
  medicationName: string,
  dosage: string,
  instructions?: string,
): ScheduledDose => {
  const [hours, minutes] = time.split(':').map(Number);

  const scheduledFor = new Date(date);
  scheduledFor.setHours(hours, minutes, 0, 0);

  return {
    eventType: 'MEDICATION_DOSE',
    title: `Take ${medicationName}`,
    description: [dosage, instructions].filter(Boolean).join(' — '),
    scheduledFor,
    metadata: { medicationName, dosage, time },
    reminderOffsetMinutes: MEDICATION_REMINDER_OFFSET_MINUTES,
  };
};