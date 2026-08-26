import { z } from 'zod';

/**
 * What a caller may say about an appointment.
 *
 * `personId` is optional on every one of these and means "whose record is this
 * about". Absent, it resolves to the caller's own Person — which is what makes
 * a single-account user's request work unchanged while a caregiver acting for
 * a dependent names the subject explicitly. It is never trusted on its own:
 * `personAccess.resolveSubject` decides whether the caller may touch it.
 */

/** Minutes before the start to remind. Bounded so a caller cannot ask for a
 *  reminder two years early, and deduplicated so three identical entries do
 *  not become three identical notifications. */
const reminderLeadMinutes = z
  .array(z.number().int().min(0).max(43_200))
  .max(5)
  .transform((values) => Array.from(new Set(values)).sort((a, b) => b - a));

export const createAppointmentSchema = z.object({
  personId: z.string().uuid().optional(),
  title: z.string().min(1).max(200),
  /**
   * Absolute instant, ISO 8601. Deliberately not a date-and-timezone pair:
   * the care engine schedules on DateTime, and an appointment that meant
   * different moments to two people looking at the same record would be a bug
   * with clinical consequences.
   */
  startsAt: z.coerce.date(),
  durationMinutes: z.number().int().min(5).max(1440).default(30),
  clinician: z.string().max(200).optional(),
  specialty: z.string().max(120).optional(),
  location: z.string().max(300).optional(),
  reason: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
  reminderLeadMinutes: reminderLeadMinutes.optional(),
});

/**
 * Everything a caller may change afterwards.
 *
 * `status` is absent on purpose. Cancelling and completing are their own
 * endpoints because each has consequences beyond a column — reminders to
 * withdraw, a calendar entry to clean up — and a general-purpose PATCH that
 * could set `CANCELLED` would let those be skipped silently.
 */
export const updateAppointmentSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    startsAt: z.coerce.date().optional(),
    durationMinutes: z.number().int().min(5).max(1440).optional(),
    clinician: z.string().max(200).nullable().optional(),
    specialty: z.string().max(120).nullable().optional(),
    location: z.string().max(300).nullable().optional(),
    reason: z.string().max(500).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    reminderLeadMinutes: reminderLeadMinutes.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

export const cancelAppointmentSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const listAppointmentsSchema = z.object({
  personId: z.string().uuid().optional(),
  /**
   * `upcoming` is the default because it is what a caller almost always wants
   * and because an unbounded history is the expensive query.
   */
  scope: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
  status: z
    .enum(['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'MISSED'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
export type UpdateAppointmentInput = z.infer<typeof updateAppointmentSchema>;
export type ListAppointmentsInput = z.infer<typeof listAppointmentsSchema>;
