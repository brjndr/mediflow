import { z } from 'zod';

const band = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    points: z.number().int().min(0).max(9),
  })
  .refine((each) => each.min === undefined || each.max === undefined || each.min < each.max);

/** Per-hospital settings: the early warning score's bands and thresholds. */
export const nursingSettingsSchema = z.object({
  ews: z
    .object({
      bands: z.object({
        systolic: z.array(band),
        pulse: z.array(band),
        temperature: z.array(band),
        spo2: z.array(band),
      }),
      attention: z.number().int().min(1).max(30),
      urgent: z.number().int().min(1).max(30),
      singleMeasure: z.number().int().min(1).max(9),
    })
    .optional(),
});
export type NursingSettings = z.infer<typeof nursingSettingsSchema>;
