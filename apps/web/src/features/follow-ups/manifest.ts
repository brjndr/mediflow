import { CalendarClock } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Follow-ups (#88): when a patient should come back after a consultation, and the appointment
 * that books it. The API is the clinical module's, behind the same `clinical` switch; this folder
 * is the due list the front desk works from (its own navigation entry, since the desk does not
 * read consultations) and the panel the consultation shows (`FollowUpPanel`, from `index.ts`).
 */
export const followUpsFeature: FeatureManifest = {
  id: 'follow_ups',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Follow-ups' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // The clinical module's switch: a follow-up is set in a consultation.
  featureFlag: 'clinical',
  routes: [
    {
      path: 'follow-ups',
      lazy: () => import('./routes/FollowUpList'),
      requires: ['followUp:read'],
    },
  ],
  nav: { icon: CalendarClock, order: 29, requires: ['followUp:read'] },
  permissions: ['followUp:read', 'followUp:create'],
};
