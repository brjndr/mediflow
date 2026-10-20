import { ClipboardPlus } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * The OPD consultation (#80): an encounter opened from a token being served (the
 * `queue.row.actions` slot) or from today's appointment (`appointment.row.actions` and
 * `appointment.detail.actions`), with what triage found (`TriageSummary` from triage), notes kept
 * as drafts on the server and then signed, diagnoses and prescriptions (#81), each behind its own
 * permission. The consultations list brings a doctor back to a visit left open.
 */
export const clinicalFeature: FeatureManifest = {
  id: 'clinical',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Consultations', detail: 'Consultation' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'clinical',
  routes: [
    {
      path: 'encounters',
      lazy: () => import('./routes/EncounterList'),
      requires: ['encounter:read'],
    },
    {
      // Notes, diagnoses and closing need their own permissions, checked on the screen.
      path: 'encounters/:encounterId',
      titleKey: 'detail',
      lazy: () => import('./routes/EncounterDetail'),
      requires: ['encounter:read'],
    },
  ],
  nav: { icon: ClipboardPlus, order: 28, requires: ['encounter:read'] },
  permissions: [
    'encounter:read',
    'encounter:create',
    'encounter:update',
    'clinicalNote:read',
    'clinicalNote:write',
    'diagnosis:read',
    'diagnosis:write',
    'prescription:read',
    'prescription:create',
  ],
  // Opening also needs `patient:read`, checked by the component: a slot contribution requires the
  // feature's own permissions only. It opens the consultation, so it needs reading it too.
  extensions: (
    ['queue.row.actions', 'appointment.row.actions', 'appointment.detail.actions'] as const
  ).map((slot) => ({
    slot,
    component: () => import('./components/StartConsultationAction'),
    requires: ['encounter:create', 'encounter:read'],
    order: 20,
  })),
};
