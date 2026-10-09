import { z } from 'zod';

/** Per-hospital settings, stored in tenant_feature_settings and delivered with the tenant config. */
export const noticesSettingsSchema = z.object({
  /** How many notices the dashboard widget shows. */
  widgetCount: z.number().int().min(1).max(10).default(3),
});

export type NoticesSettings = z.infer<typeof noticesSettingsSchema>;
