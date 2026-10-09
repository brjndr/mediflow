import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { isAllowed, isFeatureEnabled } from '@/access';
import type { AccessPolicy, Permission } from '@/shared/types';
import type {
  FeatureI18n,
  FeatureManifest,
  FeatureNav,
  FeatureSettings,
  SlotId,
  SlotProps,
} from './types';

/** i18n namespace that holds every feature's bundled titles, nested under the feature id. */
export const FEATURE_TITLES_NS = 'features';
const RESERVED_NAMESPACES = new Set(['common', FEATURE_TITLES_NS]);

/** What the i18n layer needs from the registered features. */
export interface FeatureTranslations {
  /** language -> feature id -> title strings, for the `features` namespace. */
  titles: Record<string, Record<string, Record<string, string>>>;
  /** Namespace (the feature id) -> loader for its screen strings. */
  loaders: Record<string, FeatureI18n['load']>;
}

/** Where core finds a feature's title: its own bundled titles, or core `common` without i18n. */
function titleKeyOf(feature: FeatureManifest): string {
  return feature.i18n ? `${FEATURE_TITLES_NS}:${feature.id}.${feature.titleKey}` : feature.titleKey;
}

export interface RegisteredRoute {
  featureId: string;
  featureFlag: string;
  path: string;
  requires: Permission[];
  Component: LazyExoticComponent<ComponentType>;
}

export interface NavItem {
  featureId: string;
  /** Ready to pass to `t()`. */
  titleKey: string;
  /** Absolute path to link to. */
  to: string;
  icon: FeatureNav['icon'];
}

export interface ResolvedContribution {
  /** Stable React key. */
  key: string;
  featureId: string;
  Component: LazyExoticComponent<ComponentType<SlotProps>>;
}

export interface SettingsSection extends FeatureSettings {
  featureId: string;
  titleKey: string;
}

/**
 * Everything the app derives from feature manifests. Core never names a feature: it asks the
 * registry what is available for the current policy.
 */
export interface Registry {
  features: readonly FeatureManifest[];
  translations: FeatureTranslations;
  /** Every registered route. Access is checked when a route renders, not when it is registered. */
  routes: readonly RegisteredRoute[];
  /** Features whose flag is on for this hospital. */
  enabledFeatures(policy: AccessPolicy | null): FeatureManifest[];
  navItems(policy: AccessPolicy | null): NavItem[];
  contributions(slot: SlotId, policy: AccessPolicy | null): ResolvedContribution[];
  settingsSections(policy: AccessPolicy | null): SettingsSection[];
}

const PERMISSION = /^[^:\s]+:[^:\s]+$/;
const RESERVED_PATHS = new Set(['login']);

function validate(manifests: readonly FeatureManifest[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const paths = new Map<string, string>();

  for (const feature of manifests) {
    const at = `Feature "${feature.id}"`;
    if (!feature.id) problems.push('A feature has no id.');
    if (ids.has(feature.id)) problems.push(`${at} is registered more than once.`);
    ids.add(feature.id);
    if (!feature.featureFlag) problems.push(`${at} has no featureFlag.`);
    if (feature.i18n) {
      if (RESERVED_NAMESPACES.has(feature.id)) {
        problems.push(`${at} uses an id reserved as an i18n namespace.`);
      }
      if (!feature.i18n.titles.en?.[feature.titleKey]) {
        problems.push(`${at} has no English title for "${feature.titleKey}" in i18n.titles.`);
      }
    }

    const declared = new Set<string>(feature.permissions);
    for (const permission of feature.permissions) {
      if (!PERMISSION.test(permission)) {
        problems.push(`${at} declares "${permission}", which is not in resource:action form.`);
      }
    }
    const checkRequires = (where: string, requires: readonly Permission[] = []) => {
      for (const permission of requires) {
        if (!declared.has(permission)) {
          problems.push(`${at} ${where} requires "${permission}" but does not declare it.`);
        }
      }
    };

    for (const route of feature.routes) {
      const where = `route "${route.path}"`;
      if (!route.path || route.path.startsWith('/')) {
        problems.push(`${at} ${where} must be a relative path without a leading slash.`);
      }
      if (RESERVED_PATHS.has(route.path.split('/')[0] ?? '')) {
        problems.push(`${at} ${where} uses a path reserved by the app.`);
      }
      const owner = paths.get(route.path);
      if (owner) problems.push(`${at} ${where} is already registered by "${owner}".`);
      paths.set(route.path, feature.id);
      checkRequires(where, route.requires);
    }

    if (feature.nav) {
      checkRequires('nav', feature.nav.requires);
      const target = feature.nav.path ?? feature.routes[0]?.path;
      if (target === undefined || !feature.routes.some((route) => route.path === target)) {
        problems.push(`${at} nav must link to one of its own routes.`);
      }
    }
    for (const extension of feature.extensions ?? []) {
      checkRequires(`extension to "${extension.slot}"`, extension.requires);
    }
    const widgetIds = new Set<string>();
    for (const widget of feature.dashboardWidgets ?? []) {
      if (widgetIds.has(widget.id)) problems.push(`${at} has two widgets with id "${widget.id}".`);
      widgetIds.add(widget.id);
      checkRequires(`widget "${widget.id}"`, widget.requires);
    }
    if (feature.settings) checkRequires('settings', feature.settings.requires);
  }
  return problems;
}

interface Contribution extends ResolvedContribution {
  slot: SlotId;
  featureFlag: string;
  requires: Permission[];
  order: number;
}

/**
 * Builds the registry from the registered manifests. A broken manifest stops the app at startup
 * with every problem listed, instead of failing later on some screen.
 */
export function createRegistry(manifests: readonly FeatureManifest[]): Registry {
  const problems = validate(manifests);
  if (problems.length > 0) {
    throw new Error(`Invalid feature manifests:\n- ${problems.join('\n- ')}`);
  }

  // React.lazy is created once per loader here, never during render.
  const routes: RegisteredRoute[] = manifests.flatMap((feature) =>
    feature.routes.map((route) => ({
      featureId: feature.id,
      featureFlag: feature.featureFlag,
      path: route.path,
      requires: route.requires,
      Component: lazy(route.lazy),
    })),
  );

  const contributions: Contribution[] = manifests.flatMap((feature) => [
    ...(feature.extensions ?? []).map((extension, index) => ({
      key: `${feature.id}:${extension.slot}:${index}`,
      featureId: feature.id,
      featureFlag: feature.featureFlag,
      slot: extension.slot,
      requires: extension.requires ?? [],
      order: extension.order ?? 0,
      Component: lazy(extension.component),
    })),
    ...(feature.dashboardWidgets ?? []).map((widget) => ({
      key: `${feature.id}:widget:${widget.id}`,
      featureId: feature.id,
      featureFlag: feature.featureFlag,
      slot: 'dashboard.widgets' as const,
      requires: widget.requires ?? [],
      order: widget.order ?? 0,
      Component: lazy(widget.component),
    })),
  ]);

  const translations: FeatureTranslations = { titles: {}, loaders: {} };
  for (const feature of manifests) {
    if (!feature.i18n) continue;
    translations.loaders[feature.id] = feature.i18n.load;
    for (const [language, titles] of Object.entries(feature.i18n.titles)) {
      translations.titles[language] = { ...translations.titles[language], [feature.id]: titles };
    }
  }

  return {
    features: manifests,
    translations,
    routes,
    enabledFeatures: (policy) =>
      manifests.filter((feature) => isFeatureEnabled(policy, feature.featureFlag)),
    navItems: (policy) =>
      manifests
        .filter(
          (feature) =>
            feature.nav &&
            isAllowed(policy, { requires: feature.nav.requires, featureFlag: feature.featureFlag }),
        )
        .sort((a, b) => (a.nav?.order ?? 0) - (b.nav?.order ?? 0))
        .flatMap((feature) => {
          const { nav } = feature;
          const path = nav?.path ?? feature.routes[0]?.path;
          if (!nav || path === undefined) return [];
          return [
            {
              featureId: feature.id,
              titleKey: titleKeyOf(feature),
              to: `/${path}`,
              icon: nav.icon,
            },
          ];
        }),
    contributions: (slot, policy) =>
      contributions
        .filter(
          (contribution) =>
            contribution.slot === slot &&
            isAllowed(policy, {
              requires: contribution.requires,
              featureFlag: contribution.featureFlag,
            }),
        )
        // Array.prototype.sort is stable, so equal orders keep registration order.
        .sort((a, b) => a.order - b.order)
        .map(({ key, featureId, Component }) => ({ key, featureId, Component })),
    settingsSections: (policy) =>
      manifests.flatMap((feature) => {
        const { settings } = feature;
        if (!settings) return [];
        const allowed = isAllowed(policy, {
          requires: settings.requires,
          featureFlag: feature.featureFlag,
        });
        return allowed
          ? [{ ...settings, featureId: feature.id, titleKey: titleKeyOf(feature) }]
          : [];
      }),
  };
}
