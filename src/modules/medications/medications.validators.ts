import { z } from 'zod';

const VALID_FREQUENCIES = [
  'ONCE_DAILY',
  'TWICE_DAILY',
  'THREE_TIMES_DAILY',
] as const;

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const expectedTimesCount: Record<(typeof VALID_FREQUENCIES)[number], number> = {
  ONCE_DAILY: 1,
  TWICE_DAILY: 2,
  THREE_TIMES_DAILY: 3,
};

export const createMedicationSchema = z
  .object({
    name: z.string().min(1, 'Medication name is required').max(200),
    dosage: z.string().min(1, 'Dosage is required').max(100),
    frequency: z.enum(VALID_FREQUENCIES, {
      error: `Frequency must be one of: ${VALID_FREQUENCIES.join(', ')}`,
    }),
    startDate: z.string().regex(dateRegex, 'Start date must be in YYYY-MM-DD format'),
    endDate: z.string().regex(dateRegex, 'End date must be in YYYY-MM-DD format').optional(),
    durationDays: z.coerce.number().int().min(1).max(365).optional(),
    customTimes: z
      .array(z.string().regex(timeRegex, 'Times must be in HH:MM format'))
      .min(1, 'At least one custom time is required')
      .max(3, 'A maximum of 3 custom times is allowed'),
    instructions: z.string().max(500).optional(),
  })
  .refine((data) => !!data.endDate !== !!data.durationDays, {
    message: 'Provide either endDate or durationDays, but not both',
    path: ['endDate'],
  })
  .refine((data) => new Set(data.customTimes).size === data.customTimes.length, {
    message: 'customTimes must not contain duplicate values',
    path: ['customTimes'],
  })
  .refine((data) => data.customTimes.length === expectedTimesCount[data.frequency], {
    message: 'Number of customTimes must match the selected frequency',
    path: ['customTimes'],
  });

export type CreateMedicationInput = z.infer<typeof createMedicationSchema>;