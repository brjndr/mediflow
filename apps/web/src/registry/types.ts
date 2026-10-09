import type { ComponentType } from 'react';
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

/**
 * A dynamic import of a module whose default export is the component, e.g.
 * `() => import('./routes/PatientList')`. Keeps every route and contribution in its own chunk.
 */
export type LazyComponent<Props = object> = () => Promise<{ default: ComponentType<Props> }>;

/** What the host screen passes to the components contributed to one of its slots. */
export interface SlotProps {
  /** Ids and values from the host, e.g. `{ patientId }`. Never whole records. */
  context?: Readonly<Record<string, unknown>>;
}

export interface FeatureRoute {
  /** Relative to the app root, without a leading slash: `patients/new`. */
  path: string;
  lazy: LazyComponent;
  requires: Permission[];
}

export interface FeatureNav {
  /** The icon component itself (`import { Users } from 'lucide-react'`), so it tree-shakes. */
  icon: ComponentType<{ className?: string }>;
  /** Lower comes first. */
  order: number;
  requires: Permission[];
  /** Where the item links to. Defaults to the feature's first route. */
  path?: string;
}

export interface SlotContribution {
  slot: SlotId;
  component: LazyComponent<SlotProps>;
  requires?: Permission[];
  /** Position among the contributions to this slot. Lower comes first. Defaults to 0. */
  order?: number;
}

export interface DashboardWidget {
  /** Unique within the feature. */
  id: string;
  component: LazyComponent<SlotProps>;
  requires?: Permission[];
  order?: number;
}

export interface FeatureSettings {
  section: string;
  schema: unknown /* Zod schema */;
  requires: Permission[];
}

/** What a feature module declares in its manifest.ts. Routes, navigation and slots come from it. */
export interface FeatureManifest {
  id: string;
  titleKey: string;
  /** Tenant-level on/off switch. The feature is unreachable in a hospital where it is off. */
  featureFlag: string;
  routes: FeatureRoute[];
  nav?: FeatureNav;
  /** Every permission the feature uses. Anything in a `requires` must be listed here. */
  permissions: Permission[];
  extensions?: SlotContribution[];
  settings?: FeatureSettings;
  /** Shorthand for contributions to the `dashboard.widgets` slot. */
  dashboardWidgets?: DashboardWidget[];
}
