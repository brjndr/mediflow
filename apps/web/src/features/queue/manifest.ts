import { ListOrdered } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * The OPD token queue: today's tokens per department and doctor, issued at the desk to walk-ins
 * (#76), called, skipped and recalled on a board that follows the server's events. It names a
 * patient by id only, chooses departments and doctors from those features, adds "Issue a token"
 * to the patient's screen through the `patient.detail.actions` slot, and "Check in" to today's
 * appointments through `appointment.row.actions` and `appointment.detail.actions` (#376).
 */
export const queueFeature: FeatureManifest = {
  id: 'queue',
  titleKey: 'title',
  i18n: {
    titles: {
      en: { title: 'OPD queue', issue: 'Issue a token', displayTitle: 'Waiting-room display' },
    },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'queue',
  routes: [
    {
      // Calling needs `queue:call`, checked on the screen for each action.
      path: 'queue',
      lazy: () => import('./routes/QueueBoard'),
      requires: ['queue:read'],
    },
    {
      // The screen for a waiting room: numbers only. Opened from the board, not in the menu.
      path: 'queue/display',
      titleKey: 'displayTitle',
      lazy: () => import('./routes/QueueDisplay'),
      requires: ['queue:read'],
    },
    {
      path: 'queue/new',
      titleKey: 'issue',
      lazy: () => import('./routes/QueueIssue'),
      requires: ['queue:create'],
    },
  ],
  nav: { icon: ListOrdered, order: 27, requires: ['queue:read'] },
  permissions: ['queue:read', 'queue:create', 'queue:call', 'queue:cancel'],
  dashboardWidgets: [
    {
      id: 'waiting',
      component: () => import('./components/WaitingWidget'),
      requires: ['queue:read'],
      size: 'md',
    },
  ],
  extensions: [
    {
      slot: 'patient.detail.actions',
      component: () => import('./components/IssueTokenAction'),
      requires: ['queue:create'],
      order: 10,
    },
    // Checking in also needs `patient:read`, checked by the component: a slot contribution
    // requires the feature's own permissions only.
    {
      slot: 'appointment.row.actions',
      component: () => import('./components/CheckInAction'),
      requires: ['queue:create'],
      order: 10,
    },
    {
      slot: 'appointment.detail.actions',
      component: () => import('./components/CheckInAction'),
      requires: ['queue:create'],
      order: 10,
    },
  ],
};
