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
  | 'appointment.detail.actions'
  | 'queue.row.actions'
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
  /**
   * The page's title in the browser tab, as a key of `i18n.titles` (or of core `common` without
   * i18n). Defaults to the feature's own title; each route of a feature needs a title of its
   * own. Static words only, never the record's name: a title stays in the browser's history.
   */
  titleKey?: string;
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

/**
 * A kind of record that can be linked to from outside the app (an email, a notification).
 * The link is `/open/<kind>/<id>`: the server works out which hospital the record belongs to and
 * switches to it, then the app goes to the address given here.
 */
export interface FeatureLink {
  /** Unique across features, lower snake case: `notice`, `lab_result`. */
  kind: string;
  /** Where the record is shown, relative like a route path: `patients/${id}`. */
  to: (id: string) => string;
}

export interface FeatureSettings {
  section: string;
  schema: unknown /* Zod schema */;
  requires: Permission[];
}

/** Nested translation strings, as in a locale JSON file. */
export interface TranslationTree {
  [key: string]: string | TranslationTree;
}

/**
 * A feature's own translations, so adding a feature never edits core locale files.
 * Screens use the feature id as their namespace: `useTranslation('patients')`.
 */
export interface FeatureI18n {
  /**
   * Strings core needs before the feature's code loads (the nav title, the settings section
   * title), by language. Bundled with the manifest, so keep this to a few short strings.
   * English is required; other languages fall back to it.
   */
  titles: { en: Record<string, string> } & Record<string, Record<string, string>>;
  /**
   * Loads the screen strings for one language on demand, usually
   * `(language) => import(`./locales/${language}.json`)`.
   * A language with no file falls back to English.
   */
  load: (language: string) => Promise<{ default: TranslationTree }>;
}

/** What a feature module declares in its manifest.ts. Routes, navigation and slots come from it. */
export interface FeatureManifest {
  id: string;
  /** Key of the feature's title in `i18n.titles`, or a key in core `common` when it has no i18n. */
  titleKey: string;
  i18n?: FeatureI18n;
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
  /** Records of this feature that deep links can point at. */
  links?: FeatureLink[];
}
