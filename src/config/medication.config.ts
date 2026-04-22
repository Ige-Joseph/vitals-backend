// ─────────────────────────────────────────────
// Medication frequency definitions
// All schedule logic is driven from this config — not hardcoded in services
// ─────────────────────────────────────────────

export type FrequencyKey =
  | 'ONCE_DAILY'
  | 'TWICE_DAILY'
  | 'THREE_TIMES_DAILY';

export interface FrequencyDefinition {
  label: string;
  timesPerDay: number;
  // Default times in 24h format — user can override
  defaultTimes: string[];
}

export const FREQUENCY_DEFINITIONS: Record<FrequencyKey, FrequencyDefinition> = {
  ONCE_DAILY: {
    label: 'Once daily',
    timesPerDay: 1,
    defaultTimes: ['08:00'],
  },
  TWICE_DAILY: {
    label: 'Twice daily',
    timesPerDay: 2,
    defaultTimes: ['08:00', '20:00'],
  },
  THREE_TIMES_DAILY: {
    label: 'Three times daily',
    timesPerDay: 3,
    defaultTimes: ['08:00', '14:00', '20:00'],
  },
};

// Maximum days a medication schedule can span for MVP (1 year)
export const MAX_SCHEDULE_DAYS = 365;

// How many minutes before dose time to send the reminder
export const MEDICATION_REMINDER_OFFSET_MINUTES = 15;