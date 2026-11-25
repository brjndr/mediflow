import type { RequestHandler } from 'msw';

/**
 * The mock API's feature handlers, by file, in the order MSW must offer them (the order of the
 * list in handlers.ts). `segments` are the first path segments after `/api/` that the file
 * answers; `handler-groups.test.ts` checks that none is missing. The browser loads only the
 * files that a request's segment names, so a page pays to build the handlers it uses and not
 * the several hundred of the whole mock (#1176).
 */
export interface HandlerGroup {
  name: string;
  segments: readonly string[];
  load: () => Promise<readonly RequestHandler[]>;
}

export const handlerGroups: readonly HandlerGroup[] = [
  {
    name: 'notices',
    segments: ['notices'],
    load: async () => {
      const m = await import('./handlers/notices');
      return m.noticesHandlers;
    },
  },
  {
    name: 'examples',
    segments: ['examples'],
    load: async () => {
      const m = await import('./handlers/examples');
      return m.examplesHandlers;
    },
  },
  {
    name: 'patients',
    segments: ['patient-settings', 'patients'],
    load: async () => {
      const m = await import('./handlers/patients');
      return m.patientsHandlers;
    },
  },
  {
    name: 'departments',
    segments: ['departments'],
    load: async () => {
      const m = await import('./handlers/departments');
      return m.departmentsHandlers;
    },
  },
  {
    name: 'roles',
    segments: ['permission-catalog', 'roles'],
    load: async () => {
      const m = await import('./handlers/roles');
      return m.rolesHandlers;
    },
  },
  {
    name: 'hospital-profile',
    segments: ['hospital-profile'],
    load: async () => {
      const m = await import('./handlers/hospital-profile');
      return m.hospitalProfileHandlers;
    },
  },
  {
    name: 'doctors',
    segments: ['doctors'],
    load: async () => {
      const m = await import('./handlers/doctors');
      return m.doctorsHandlers;
    },
  },
  {
    name: 'appointments',
    segments: ['appointments'],
    load: async () => {
      const m = await import('./handlers/appointments');
      return [...m.appointmentsHandlers, ...m.bookingHandlers, ...m.appointmentChangeHandlers];
    },
  },
  {
    name: 'queue',
    segments: ['queue'],
    load: async () => {
      const m = await import('./handlers/queue');
      return m.queueHandlers;
    },
  },
  {
    name: 'triage',
    segments: ['allergens', 'patients', 'vitals'],
    load: async () => {
      const m = await import('./handlers/triage');
      return m.triageHandlers;
    },
  },
  {
    name: 'nursing-diet',
    segments: ['admissions', 'diet', 'encounters'],
    load: async () => {
      const m = await import('./handlers/nursing-diet');
      return m.dietHandlers;
    },
  },
  {
    name: 'clinical',
    segments: [
      'diagnoses',
      'encounters',
      'follow-ups',
      'notes',
      'orders',
      'prescriptions',
      'referrals',
    ],
    load: async () => {
      const m = await import('./handlers/clinical');
      return m.clinicalHandlers;
    },
  },
  {
    name: 'prescription-sets',
    segments: ['me', 'prescription-sets'],
    load: async () => {
      const m = await import('./handlers/prescription-sets');
      return m.prescriptionSetsHandlers;
    },
  },
  {
    name: 'billing',
    segments: [
      'billing',
      'cash-registers',
      'charges',
      'encounters',
      'invoices',
      'payments',
      'services',
    ],
    load: async () => {
      const m = await import('./handlers/billing');
      return m.billingHandlers;
    },
  },
  {
    name: 'stay-bill',
    segments: ['admissions', 'billing'],
    load: async () => {
      const m = await import('./handlers/stay-bill');
      return m.stayBillHandlers;
    },
  },
  {
    name: 'discharge-plan',
    segments: ['admissions'],
    load: async () => {
      const m = await import('./handlers/discharge-plan');
      return m.dischargePlanHandlers;
    },
  },
  {
    name: 'discharge-summary',
    segments: ['admission-settings', 'admissions'],
    load: async () => {
      const m = await import('./handlers/discharge-summary');
      return m.dischargeSummaryHandlers;
    },
  },
  {
    name: 'lab',
    segments: ['lab'],
    load: async () => {
      const m = await import('./handlers/lab');
      return m.labHandlers;
    },
  },
  {
    name: 'radiology',
    segments: ['radiology'],
    load: async () => {
      const m = await import('./handlers/radiology');
      return m.radiologyHandlers;
    },
  },
  {
    name: 'inventory',
    segments: ['inventory'],
    load: async () => {
      const m = await import('./handlers/inventory');
      return m.inventoryHandlers;
    },
  },
  {
    name: 'indents',
    segments: ['inventory'],
    load: async () => {
      const m = await import('./handlers/indents');
      return m.indentHandlers;
    },
  },
  {
    name: 'purchasing',
    segments: ['purchasing'],
    load: async () => {
      const m = await import('./handlers/purchasing');
      return m.purchasingHandlers;
    },
  },
  {
    name: 'pharmacy',
    segments: ['pharmacy'],
    load: async () => {
      const m = await import('./handlers/pharmacy');
      return m.pharmacyHandlers;
    },
  },
  {
    name: 'pharmacy-sales',
    segments: ['pharmacy'],
    load: async () => {
      const m = await import('./handlers/pharmacy-sales');
      return m.pharmacySaleHandlers;
    },
  },
  {
    name: 'staff',
    segments: ['invites', 'staff'],
    load: async () => {
      const m = await import('./handlers/staff');
      return m.staffHandlers;
    },
  },
  {
    name: 'services',
    segments: ['price-lists', 'services'],
    load: async () => {
      const m = await import('./handlers/services');
      return m.servicesHandlers;
    },
  },
  {
    name: 'drugs',
    segments: ['drugs'],
    load: async () => {
      const m = await import('./handlers/drugs');
      return m.drugsHandlers;
    },
  },
  {
    name: 'lab-tests',
    segments: ['lab-tests'],
    load: async () => {
      const m = await import('./handlers/lab-tests');
      return m.labTestsHandlers;
    },
  },
  {
    name: 'wards',
    segments: ['bed-categories', 'wards'],
    load: async () => {
      const m = await import('./handlers/wards');
      return m.wardsHandlers;
    },
  },
  {
    name: 'nursing',
    segments: ['admissions', 'care-plan-tasks', 'care-plans', 'mar', 'progress-notes'],
    load: async () => {
      const m = await import('./handlers/nursing');
      return m.nursingHandlers;
    },
  },
  {
    name: 'admissions',
    segments: ['admissions', 'bed-reservations', 'beds'],
    load: async () => {
      const m = await import('./handlers/admissions');
      return m.admissionsHandlers;
    },
  },
  {
    name: 'housekeeping',
    segments: ['cleaning-tasks'],
    load: async () => {
      const m = await import('./handlers/housekeeping');
      return m.housekeepingHandlers;
    },
  },
  {
    name: 'ambulances',
    segments: ['ambulance-trips', 'ambulances'],
    load: async () => {
      const m = await import('./handlers/ambulances');
      return m.ambulanceHandlers;
    },
  },
  {
    name: 'theatre',
    segments: ['theatre'],
    load: async () => {
      const m = await import('./handlers/theatre');
      return m.theatreHandlers;
    },
  },
  {
    name: 'emergency',
    segments: ['emergency'],
    load: async () => {
      const m = await import('./handlers/emergency');
      return m.emergencyHandlers;
    },
  },
  {
    name: 'blood-bank',
    segments: ['blood', 'blood-units', 'patients', 'transfusion-reactions'],
    load: async () => {
      const m = await import('./handlers/blood-bank');
      return m.bloodBankHandlers;
    },
  },
  {
    name: 'blood-donors',
    segments: ['blood'],
    load: async () => {
      const m = await import('./handlers/blood-donors');
      return m.bloodDonorHandlers;
    },
  },
  {
    name: 'insurance',
    segments: ['payer-plans', 'payers', 'rate-agreements'],
    load: async () => {
      const m = await import('./handlers/insurance');
      return m.insuranceHandlers;
    },
  },
  {
    name: 'coverage',
    segments: ['encounters', 'patient-policies', 'patients', 'pre-auths'],
    load: async () => {
      const m = await import('./handlers/coverage');
      return m.coverageHandlers;
    },
  },
  {
    name: 'coverage-split',
    segments: ['encounters'],
    load: async () => {
      const m = await import('./handlers/coverage-split');
      return m.coverageSplitHandlers;
    },
  },
  {
    name: 'claims',
    segments: ['claims', 'encounters'],
    load: async () => {
      const m = await import('./handlers/claims');
      return m.claimHandlers;
    },
  },
  {
    name: 'credit',
    segments: ['credit-accounts', 'encounters', 'payers'],
    load: async () => {
      const m = await import('./handlers/credit');
      return m.creditHandlers;
    },
  },
  {
    name: 'codes',
    segments: ['codes'],
    load: async () => {
      const m = await import('./handlers/codes');
      return m.codesHandlers;
    },
  },
  {
    name: 'templates',
    segments: ['templates'],
    load: async () => {
      const m = await import('./handlers/templates');
      return m.templatesHandlers;
    },
  },
  {
    name: 'documents',
    segments: [
      'document-files',
      'document-retention',
      'document-uploads',
      'documents',
      'legal-holds',
      'patients',
    ],
    load: async () => {
      const m = await import('./handlers/documents');
      return m.documentsHandlers;
    },
  },
  {
    name: 'consents',
    segments: ['certificate-formats', 'consents', 'patients'],
    load: async () => {
      const m = await import('./handlers/consents');
      return m.consentsHandlers;
    },
  },
  {
    name: 'records',
    segments: ['record-requests', 'records'],
    load: async () => {
      const m = await import('./handlers/records');
      return m.recordsHandlers;
    },
  },
  {
    name: 'roster',
    segments: ['roster'],
    load: async () => {
      const m = await import('./handlers/roster');
      return m.rosterHandlers;
    },
  },
  {
    name: 'imports',
    segments: ['imports'],
    load: async () => {
      const m = await import('./handlers/imports');
      return m.importsHandlers;
    },
  },
  {
    name: 'reports',
    segments: ['reports'],
    load: async () => {
      const m = await import('./handlers/reports');
      return m.reportsHandlers;
    },
  },
  {
    name: 'audit',
    segments: ['audit'],
    load: async () => {
      const m = await import('./handlers/audit');
      return m.auditHandlers;
    },
  },
  {
    name: 'auth',
    segments: ['auth'],
    load: async () => {
      const m = await import('./handlers/auth');
      return m.accountHandlers;
    },
  },
  {
    name: 'mfa',
    segments: ['auth'],
    load: async () => {
      const m = await import('./handlers/mfa');
      return m.mfaHandlers;
    },
  },
  {
    name: 'platform',
    segments: ['platform'],
    load: async () => {
      const m = await import('./handlers/platform');
      return m.platformHandlers;
    },
  },
];
