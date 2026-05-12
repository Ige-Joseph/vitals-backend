import { z } from 'zod';

export const createTextMedicationDraftSchema = z.object({
  message: z
    .string()
    .min(3, 'Message must be at least 3 characters')
    .max(1000, 'Message is too long'),
});

export const updateMedicationDraftSchema = z.object({
  message: z
    .string()
    .min(1, 'Message is required')
    .max(1000, 'Message is too long'),
});

export const draftIdParamSchema = z.object({
  id: z.string().uuid('Invalid draft id'),
});

export type CreateTextMedicationDraftInput = z.infer<
  typeof createTextMedicationDraftSchema
>;

export type UpdateMedicationDraftInput = z.infer<
  typeof updateMedicationDraftSchema
>;