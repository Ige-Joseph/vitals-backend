import { z } from 'zod';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const setupPregnancySchema = z
  .object({
    lmpDate: z
      .string()
      .regex(dateRegex, 'lmpDate must be in YYYY-MM-DD format')
      .optional(),
    pregnancyWeekAtSetup: z.coerce.number().int().min(1).max(42).optional(),
  })
  .refine((data) => !!data.lmpDate !== (data.pregnancyWeekAtSetup !== undefined), {
    message: 'Provide either lmpDate or pregnancyWeekAtSetup, but not both',
    path: ['lmpDate'],
  });

export const recordDeliverySchema = z.object({
  deliveryDate: z
    .string()
    .regex(dateRegex, 'Delivery date must be in YYYY-MM-DD format'),
  babyName: z.string().max(100).optional(),
});

export const babyProfileSchema = z.object({
  deliveryDate: z
    .string()
    .regex(dateRegex, 'Delivery date must be in YYYY-MM-DD format'),
  babyName: z.string().max(100).optional(),
});

export type SetupPregnancyInput = z.infer<typeof setupPregnancySchema>;
export type RecordDeliveryInput = z.infer<typeof recordDeliverySchema>;