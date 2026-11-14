import { ShieldCheck } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Roles: the hospital's built-in roles and its own. An admin lists them, adds, renames and
 * deletes custom roles; built-in roles are shown and protected. What each role may do (the
 * permission matrix) is the next screen. The roles API has no module switch of its own, so the
 * manifest declares no flag: only the permissions apply.
 */
export const rolesFeature: FeatureManifest = {
  id: 'roles',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Roles', matrix: 'Role permissions' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  routes: [
    { path: 'roles', lazy: () => import('./routes/RolesPage'), requires: ['role:read'] },
    {
      path: 'roles/:roleId',
      titleKey: 'matrix',
      lazy: () => import('./routes/RoleMatrix'),
      requires: ['role:read'],
    },
  ],
  nav: { icon: ShieldCheck, order: 810, requires: ['role:read'] },
  permissions: ['role:read', 'role:manage'],
};
