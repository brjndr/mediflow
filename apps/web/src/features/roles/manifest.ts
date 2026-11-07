import { ShieldCheck } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Roles: the hospital's built-in roles and its own. An admin lists them, adds, renames and
 * deletes custom roles; built-in roles are shown and protected. What each role may do (the
 * permission matrix) is the next screen. The roles API has no module switch of its own: the
 * `roles` switch only decides whether the screen is offered.
 */
export const rolesFeature: FeatureManifest = {
  id: 'roles',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Roles' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'roles',
  routes: [{ path: 'roles', lazy: () => import('./routes/RolesPage'), requires: ['role:read'] }],
  nav: { icon: ShieldCheck, order: 810, requires: ['role:read'] },
  permissions: ['role:read', 'role:manage'],
};
