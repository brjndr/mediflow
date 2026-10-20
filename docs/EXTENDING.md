# Adding a feature module

How a feature plugs in without touching core code: the manifest, the slots, the domain events, per-hospital settings, the checklist. Moved out of the root `CLAUDE.md` (#370), which keeps the rules (Extensibility and Access Control) and points here. Read it before adding a module, a slot, a slot contribution or an event.

## Feature modules (plug-in architecture)

Every feature is a self-contained module that declares itself in `manifest.ts`:

```ts
export const patientsFeature: FeatureManifest = {
  id: 'patients',
  titleKey: 'nav.patients',
  featureFlag: 'patients', // tenant-level on/off
  routes: [
    { path: 'patients', lazy: () => import('./routes/PatientList'), requires: ['patient:read'] },
    {
      path: 'patients/new',
      lazy: () => import('./routes/PatientCreate'),
      requires: ['patient:create'],
    },
  ],
  nav: { icon: Users, order: 20, requires: ['patient:read'] }, // the lucide-react component, not a name
  permissions: ['patient:read', 'patient:create', 'patient:update', 'patient:delete'],
  extensions: [], // slot contributions (see Extension points)
  settings: undefined, // per-hospital settings schema (optional)
  dashboardWidgets: [], // optional
};
```

- `registry/` collects all manifests, drops those whose `featureFlag` is off for the current tenant, and generates **routes, navigation, and dashboard widgets** from what remains. No hand-edited route or menu lists.
- Adding a new feature = new folder + manifest + one line registering it in `registry/features.ts`. **No edits to core, routing, or other features.** The registry validates manifests at startup (duplicate ids or paths, undeclared permissions) and stops the app with the full list of problems.
- Every route has a page title of its own in the browser tab ("Patients · Sample Hospital · Mediflow"): the feature's title for its first route, and `titleKey` (a key of `i18n.titles`) for each other route. The registry refuses two routes of one feature with the same title. A title is static words, never a record's name or MRN, since it stays in the browser's history (#339).
- Route and slot modules loaded by a manifest **default-export** their component (the one exception to named exports), so `() => import('./routes/PatientList')` works with `React.lazy`.
- Features talk to each other only via `index.ts` exports, shared types, or registry extension points (e.g. a widget slot on the patient detail page), never by importing internals.
- Unreleased features ship dark behind a feature flag and are enabled per tenant.

## Adding a new feature later

Any new feature (appointment reminders, insurance, inventory, reports, anything) must be addable **without editing core modules**. The mechanisms below are part of the foundation (step 0), not afterthoughts.

**Extension points (slots)**
Core screens render slots, and features contribute components to them through `manifest.extensions`. The registry resolves contributions by slot, feature flag, and permission. Initial slots: `patient.detail.tabs`, `patient.detail.actions`, `patient.form.fields`, `appointment.form.fields`, `appointment.row.badges`, `appointment.row.actions` and `appointment.detail.actions` (an appointment of the list and its own screen, given `appointmentId`, `patientId`, `status` and `startsAt`; #376, `patientId` since #80), `queue.row.actions` (a token of the board, given `tokenId`, `patientId`, `number` and `status`; #77), `dashboard.widgets`, `settings.sections`, `nav.items`. Add a new slot to core only when a real feature needs one, as an additive change.

The patient screen (`features/patients`) hosts `patient.detail.tabs` and `patient.detail.actions`. A contribution is given `context.patientId` and nothing else of the record. To add a tab, the contributed component renders `<DetailTab id="..." title={...}>` (exported from `@/features/patients`) around its content: the id goes in the address (`?tab=<id>`), so it is a stable, unique word (`details` is taken), never patient data. Tabs are listed in registry order. Only what is inside the `<DetailTab>` mounts when the tab is opened: the contributed component itself runs every time a patient is opened, so it reads no data. Put the queries in a component rendered inside the tab, or every tab would fetch, and be audited, on every open. An action contribution renders its own button.

**Domain events (backend contract)**
Core modules publish events through a transactional outbox (written in the same database transaction, then delivered to the queue) so subscribers never miss or duplicate-trigger on rollbacks. Initial events, each carrying `tenantId`, entity ID, actor, and timestamp:

- `patient.registered`, `patient.updated`
- `appointment.created`, `appointment.rescheduled`, `appointment.cancelled`, `appointment.completed`, `appointment.no_show`
- `encounter.opened`, `encounter.closed`, `encounter.cancelled`, `queue.token_issued`, `queue.called`, `vitals.recorded`, `allergy.updated`
- `order.placed`, `order.cancelled`, `order.completed`
- `referral.created`, `referral.cancelled`, `followup.created`, `followup.booked`, `followup.cancelled`
- `lab.sample_collected`, `lab.result_verified`, `lab.critical_value`, `imaging.reported`
- `pharmacy.dispensed`, `stock.low`, `stock.expiring`
- `charge.posted`, `invoice.issued`, `invoice.paid`, `payment.refunded`
- `admission.created`, `bed.assigned`, `bed.released`, `medication.administered`, `discharge.completed`
- `er.triaged`, `surgery.completed`, `claim.submitted`, `claim.settled`
- `master.changed` (a record of a catalog was added or changed: the kind of record, what happened and its id)

New features subscribe to events in their own module. They do not modify the module that emits them. Handlers must be idempotent.

**Per-hospital feature settings**
A feature declares `settings` (a Zod schema + permission) in its manifest. The hospital admin settings screen renders a section for each enabled feature. Values are stored per tenant (`tenant_feature_settings`, JSON validated against the schema) and delivered to the frontend with the tenant config.

**Backend module shape:** one Fastify plugin per feature, laid out as in "Fastify plugin layout" in the root `CLAUDE.md`. The core `access` hook checks the tenant's feature flag and the caller's permissions on every route of the plugin.

**Checklist for any new feature**

1. Define permissions and default role grants. Add the feature flag (off by default).
2. Backend module: tables (with `tenant_id` + RLS), API with OpenAPI, event subscribers, workers, metering/quota if it costs money.
3. Frontend: `apps/web/src/features/<name>/` with `manifest.ts`, routes, slot contributions, settings section, MSW handlers.
4. Tests: happy path, flag off, permission absent, two tenants, idempotent event handling.
5. Enable for one pilot hospital, then roll out.

**Worked example: appointment reminders (planned, not in v1)**
In `docs/ARCHITECTURE.md`: a `reminders` module added with no change to core. What v1 must already provide for it: the appointment events, the `Notifier` abstraction, patient phone/email/`contactConsent` captured at registration, the slot and settings mechanisms, and feature flags with per-tenant settings.
