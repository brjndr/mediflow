import type { Permission } from '@/shared/types';

/** Extension slots that core screens render. Add one only when a real feature needs it (additive). */
export type SlotId =
  | 'patient.detail.tabs'
  | 'patient.detail.actions'
  | 'patient.form.fields'
  | 'appointment.form.fields'
  | 'appointment.row.badges'
  | 'appointment.row.actions'
  | 'dashboard.widgets'
  | 'settings.sections'
  | 'nav.items';

/** What a feature module declares in its manifest.ts. F-08 builds routes and navigation from these. */
export interface FeatureManifest {
  id: string;
  titleKey: string;
  featureFlag: string;
  routes: { path: string; lazy: () => Promise<unknown>; requires: Permission[] }[];
  nav?: { icon: string; order: number; requires: Permission[] };
  permissions: Permission[];
  extensions?: { slot: SlotId; component: () => Promise<unknown>; requires?: Permission[] }[];
  settings?: { section: string; schema: unknown /* Zod schema */; requires: Permission[] };
  dashboardWidgets?: unknown[];
}
