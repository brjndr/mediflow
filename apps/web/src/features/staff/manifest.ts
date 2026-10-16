import { UserCog } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Staff: who works at the hospital. A hospital admin sees its members and open invitations,
 * invites people by email into a role (one at a time or from a file), deactivates and
 * reactivates a membership, and ends someone's sessions.
 */
export const staffFeature: FeatureManifest = {
  id: 'staff',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Staff', invite: 'Invite staff' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'staff',
  routes: [
    { path: 'staff', lazy: () => import('./routes/StaffList'), requires: ['staff:read'] },
    {
      path: 'staff/invite',
      titleKey: 'invite',
      lazy: () => import('./routes/StaffInvite'),
      requires: ['staff:invite'],
    },
  ],
  nav: { icon: UserCog, order: 800, requires: ['staff:read'] },
  permissions: ['staff:read', 'staff:invite', 'staff:manage'],
};
