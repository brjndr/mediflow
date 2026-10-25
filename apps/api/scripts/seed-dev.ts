// Run with `pnpm --filter api db:seed`. Development only.
//
// Fills the local database with the same two sample hospitals and four sample staff the web
// app's mock API has, so the real API can be signed in to. Synthetic data only. Safe to run
// again: existing rows are updated in place.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { MRN_DIGITS, mrnPrefix } from '../src/features/patients/repository.js';
import { buildApp } from '../src/app.js';
import { syncRoleDefaults } from '../src/core/access/sync.js';
import { hashPassword } from '../src/core/auth/password.js';
import { loadConfig } from '../src/core/config/config.js';
import { seedDecision } from '../src/core/db/seed-guard.js';
import { fileSha256, loadCodes } from '../src/features/codes/load.js';

/** The one password of every sample account. Printed below; it protects nothing. */
const DEV_PASSWORD = 'sample-staff-local-only';

/** Made-up people. No real patient data ever goes into a development database. */
const SAMPLE_PATIENTS = 250;
const SAMPLE_FIRST_NAMES = [
  'Asha',
  'Bilal',
  'Chitra',
  'Dev',
  'Esha',
  'Farhan',
  'Gauri',
  'Harish',
  'Indu',
  'Jatin',
  'Kavya',
  'Lokesh',
  'Meera',
  'Nikhil',
  'Ojas',
  'Pooja',
  'Rahul',
  'Sana',
  'Tarun',
  'Uma',
];
const SAMPLE_LAST_NAMES = [
  'Verma',
  'Khan',
  'Iyer',
  'Patel',
  'Nair',
  'Singh',
  'Das',
  'Reddy',
  'Joshi',
  'Mehta',
  'Bose',
  'Kulkarni',
  'Fernandes',
  'Gill',
  'Chopra',
  'Rao',
  'Sharma',
];

const SAMPLE_DEPARTMENTS = [
  'Cardiology',
  'Emergency',
  'General Medicine',
  'General Surgery',
  'Gynaecology',
  'Laboratory',
  'Orthopaedics',
  'Paediatrics',
  'Pharmacy',
  'Radiology',
];

/**
 * A price catalog in every category: [category, code prefix, name, price in minor units]. A price
 * of 0 is a service set up and not priced yet.
 */
const SAMPLE_SERVICES: readonly [string, string, string, number][] = [
  ['consultation', 'CON', 'General consultation', 50000],
  ['consultation', 'CON', 'Specialist consultation', 90000],
  ['consultation', 'CON', 'Follow-up consultation', 30000],
  ['consultation', 'CON', 'Emergency consultation', 120000],
  ['consultation', 'CON', 'Tele-review', 0],
  ['procedure', 'PRO', 'Wound dressing', 25000],
  ['procedure', 'PRO', 'Suturing', 80000],
  ['procedure', 'PRO', 'Injection administration', 10000],
  ['procedure', 'PRO', 'Nebulisation', 15000],
  ['procedure', 'PRO', 'ECG', 40000],
  ['procedure', 'PRO', 'Plaster application', 150000],
  ['bed', 'BED', 'General ward bed day', 200000],
  ['bed', 'BED', 'Semi-private room day', 350000],
  ['bed', 'BED', 'Private room day', 600000],
  ['bed', 'BED', 'ICU bed day', 1200000],
  ['bed', 'BED', 'Day-care bed', 100000],
  ['lab', 'LAB', 'Complete blood count', 35000],
  ['lab', 'LAB', 'Blood glucose fasting', 12000],
  ['lab', 'LAB', 'Lipid profile', 70000],
  ['lab', 'LAB', 'Liver function test', 85000],
  ['lab', 'LAB', 'Kidney function test', 80000],
  ['lab', 'LAB', 'Thyroid profile', 65000],
  ['lab', 'LAB', 'Urine routine', 15000],
  ['imaging', 'IMG', 'Chest X-ray', 45000],
  ['imaging', 'IMG', 'Abdominal ultrasound', 130000],
  ['imaging', 'IMG', 'CT head plain', 350000],
  ['imaging', 'IMG', 'MRI brain', 800000],
  ['imaging', 'IMG', 'Echocardiography', 220000],
  ['package', 'PKG', 'Basic health check', 250000],
  ['package', 'PKG', 'Executive health check', 750000],
  ['package', 'PKG', 'Normal delivery package', 4500000],
];

/**
 * Medicines: [generic name, schedule]. Each is added in two strengths as a tablet, with a brand
 * made up from its name. Synthetic: not a formulary.
 */
const SAMPLE_MEDICINES: readonly [string, string][] = [
  ['Aceclofenac', 'h'],
  ['Alprazolam', 'x'],
  ['Amlodipine', 'h'],
  ['Amoxicillin', 'h'],
  ['Atorvastatin', 'h'],
  ['Azithromycin', 'h'],
  ['Cefixime', 'h1'],
  ['Cetirizine', 'none'],
  ['Ciprofloxacin', 'h'],
  ['Diclofenac', 'h'],
  ['Glimepiride', 'g'],
  ['Ibuprofen', 'none'],
  ['Levofloxacin', 'h1'],
  ['Losartan', 'h'],
  ['Metformin', 'g'],
  ['Morphine', 'narcotic'],
  ['Omeprazole', 'h'],
  ['Pantoprazole', 'h'],
  ['Paracetamol', 'none'],
  ['Tramadol', 'h1'],
];

const SAMPLE_CONSUMABLES = [
  'Cotton roll',
  'Examination gloves',
  'Gauze swab',
  'IV cannula 20G',
  'IV set',
  'Surgical mask',
  'Syringe 2 ml',
  'Syringe 5 ml',
];

/**
 * Single tests: [code, name, section, sample, container, hours, unit or null for a text result,
 * the laboratory service it is charged as or null].
 */
const SAMPLE_LAB_TESTS: readonly [
  string,
  string,
  string,
  string,
  string,
  number,
  string | null,
  string | null,
][] = [
  ['HB', 'Haemoglobin', 'haematology', 'blood', 'EDTA tube', 4, 'g/dL', null],
  ['WBC', 'White cell count', 'haematology', 'blood', 'EDTA tube', 4, '10^3/uL', null],
  ['PLT', 'Platelet count', 'haematology', 'blood', 'EDTA tube', 4, '10^3/uL', null],
  [
    'GLU-F',
    'Glucose, fasting',
    'biochemistry',
    'plasma',
    'Fluoride tube',
    4,
    'mg/dL',
    'Blood glucose fasting',
  ],
  ['CHOL', 'Total cholesterol', 'biochemistry', 'serum', 'Gel tube', 12, 'mg/dL', null],
  ['TG', 'Triglycerides', 'biochemistry', 'serum', 'Gel tube', 12, 'mg/dL', null],
  ['TSH', 'Thyroid stimulating hormone', 'hormones', 'serum', 'Gel tube', 24, 'mIU/L', null],
  ['ABO', 'Blood group and Rh type', 'serology', 'blood', 'EDTA tube', 2, null, null],
  [
    'UCS',
    'Urine culture and sensitivity',
    'microbiology',
    'urine',
    'Sterile container',
    72,
    null,
    'Urine routine',
  ],
];

/** Panels: [code, name, section, sample, container, hours, service or null, component codes]. */
const SAMPLE_LAB_PANELS: readonly [
  string,
  string,
  string,
  string,
  string,
  number,
  string | null,
  string[],
][] = [
  [
    'CBC',
    'Complete blood count',
    'haematology',
    'blood',
    'EDTA tube',
    4,
    'Complete blood count',
    ['HB', 'WBC', 'PLT'],
  ],
  [
    'LIPID',
    'Lipid profile',
    'biochemistry',
    'serum',
    'Gel tube',
    12,
    'Lipid profile',
    ['CHOL', 'TG'],
  ],
];

/**
 * Reference ranges by test code: [sex, from value, from unit, until value, until unit, low, high,
 * critical low, critical high]. Illustrative, not a laboratory's.
 */
const SAMPLE_LAB_RANGES: Record<
  string,
  [
    string,
    number,
    string,
    number | null,
    string | null,
    number,
    number,
    number | null,
    number | null,
  ][]
> = {
  HB: [
    ['male', 12, 'years', null, null, 13, 17, 7, 20],
    ['female', 12, 'years', null, null, 12, 15, 7, 20],
    ['any', 0, 'days', 1, 'months', 14, 22, 10, null],
    ['any', 1, 'months', 12, 'years', 11, 14, 7, null],
  ],
  'GLU-F': [['any', 0, 'days', null, null, 70, 100, 40, 400]],
};

/** Bed categories: [name, the bed-day service of the price catalog it is charged as]. */
const SAMPLE_BED_CATEGORIES: readonly [string, string][] = [
  ['General ward', 'General ward bed day'],
  ['Semi-private room', 'Semi-private room day'],
  ['Private room', 'Private room day'],
  ['Intensive care', 'ICU bed day'],
];

/**
 * Wards: [code, name, floor, department or null, rooms], a room being [name, bed category, the
 * numbers of its beds]. An open ward is one room with many beds.
 */
const SAMPLE_WARDS: readonly [
  string,
  string,
  string,
  string | null,
  [string, string, string[]][],
][] = [
  [
    'GEN',
    'General ward',
    'First floor',
    'General Medicine',
    [
      [
        'Open ward',
        'General ward',
        ['G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06', 'G-07', 'G-08'],
      ],
    ],
  ],
  [
    'PVT',
    'Private wing',
    'Second floor',
    null,
    [
      ['Room 201', 'Private room', ['201']],
      ['Room 202', 'Private room', ['202']],
      ['Room 203', 'Semi-private room', ['203-A', '203-B']],
    ],
  ],
  [
    'ICU',
    'Intensive care unit',
    'Ground floor',
    null,
    [['ICU', 'Intensive care', ['ICU-1', 'ICU-2', 'ICU-3', 'ICU-4']]],
  ],
];

/** The sample code sets (see sample-codes/README.md), and each hospital's favourites among them. */
const SAMPLE_CODE_FILES = [
  ['icd10', 'icd10.csv'],
  ['procedure', 'procedures.csv'],
] as const;
const SAMPLE_FAVOURITE_CODES = ['I10', 'E11.9', 'J06.9', 'PR-0003'];

/** Blank forms, one of each kind, with the placeholders their kind knows. */
const SAMPLE_TEMPLATES = [
  {
    kind: 'prescription',
    name: 'Standard prescription',
    lines: [
      '{{hospital.name}}',
      'Patient: {{patient.name}} ({{patient.mrn}}), {{patient.age}}, {{patient.sex}}',
      'Date: {{date.today}}',
      'Rx',
      'Prescribed by {{doctor.name}}',
    ],
  },
  {
    kind: 'clinical_note',
    name: 'OPD consultation note',
    lines: [
      'Complaints',
      'History',
      'Examination',
      'Plan',
      'Seen by {{doctor.name}} on {{date.today}}',
    ],
  },
  {
    kind: 'consent',
    name: 'Consent for a procedure',
    lines: [
      'I, {{patient.name}}, consent to {{procedure.name}} at {{hospital.name}}.',
      'The procedure, its risks and the alternatives have been explained to me by {{doctor.name}}.',
      'Date: {{date.today}}',
    ],
  },
  {
    kind: 'discharge_summary',
    name: 'Discharge summary',
    lines: [
      'Discharge summary',
      'Patient: {{patient.name}} ({{patient.mrn}})',
      'Admitted {{admission.date}}, discharged {{discharge.date}}',
      'Diagnosis',
      'Course in hospital',
      'Advice on discharge',
      '{{doctor.name}}',
    ],
  },
] as const;

const HOSPITALS = [
  {
    slug: 'sample-hospital',
    name: 'Sample Hospital',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    themePrimary: '#0f766e',
    // Printed on the letterhead. Not a real place.
    address: '12 Sample Road, Indiranagar\nBengaluru 560038, Karnataka',
    phone: '+91 80 4000 0000',
    registrationNumber: 'KA-CE-0000',
    // Given to the sample doctors' profiles, for the printed prescription.
    doctorCredentials: {
      qualifications: 'MBBS, MD (General Medicine)',
      registrationCouncil: 'Karnataka Medical Council',
    },
    features: {
      patients: true,
      departments: true,
      doctors: true,
      staff: true,
      services: true,
      drugs: true,
      lab_tests: true,
      wards: true,
      codes: true,
      templates: true,
      imports: true,
      appointments: true,
      queue: true,
      triage: true,
      clinical: true,
      laboratory: true,
      radiology: true,
      pharmacy: true,
      billing: true,
      reports: true,
    },
  },
  {
    // A small OPD clinic: diagnostics and pharmacy are switched off.
    slug: 'riverside-clinic',
    name: 'Riverside Clinic',
    locale: 'en-GB',
    timezone: 'Asia/Dubai',
    currency: 'AED',
    themePrimary: '#4338ca',
    // No registration number, and no council for its doctors: the print says what is missing.
    address: 'Unit 4, Riverside Walk, Dubai',
    phone: '+971 4 000 0000',
    registrationNumber: null,
    doctorCredentials: { qualifications: 'MBBS', registrationCouncil: null },
    features: {
      patients: true,
      departments: true,
      doctors: true,
      staff: true,
      services: true,
      drugs: true,
      lab_tests: true,
      wards: true,
      codes: true,
      templates: true,
      appointments: true,
      queue: true,
      triage: true,
      clinical: true,
      laboratory: false,
      radiology: false,
      pharmacy: false,
      billing: true,
      reports: false,
    },
  },
] as const;

/** The modality of each sample imaging service (#96), by name: radiology's worklist sorts by it. */
const SAMPLE_MODALITIES: readonly [string, string][] = [
  ['Chest X-ray', 'xray'],
  ['Abdominal ultrasound', 'ultrasound'],
  ['CT head plain', 'ct'],
  ['MRI brain', 'mri'],
  ['Echocardiography', 'ultrasound'],
];

const STAFF = [
  {
    email: 'admin@sample-hospital.test',
    name: 'Sample Admin',
    memberships: [{ slug: 'sample-hospital', roleId: 'admin' }],
  },
  {
    // Works at both hospitals, so picks one after signing in.
    email: 'doctor@sample-hospital.test',
    name: 'Sample Doctor',
    memberships: [
      { slug: 'sample-hospital', roleId: 'doctor' },
      { slug: 'riverside-clinic', roleId: 'doctor' },
    ],
  },
  {
    // Records vitals and allergies at triage, which a doctor only reads.
    email: 'nurse@sample-hospital.test',
    name: 'Sample Nurse',
    memberships: [{ slug: 'sample-hospital', roleId: 'nurse' }],
  },
  {
    email: 'reception@riverside-clinic.test',
    name: 'Sample Receptionist',
    memberships: [{ slug: 'riverside-clinic', roleId: 'receptionist' }],
  },
  {
    email: 'billing@riverside-clinic.test',
    name: 'Sample Billing Clerk',
    memberships: [{ slug: 'riverside-clinic', roleId: 'billing_clerk' }],
  },
] as const;

const config = loadConfig();
// Sample staff share a known password: only ever on this machine, or a host named on purpose.
const allowHost = process.argv
  .find((argument) => argument.startsWith('--allow-host='))
  ?.slice('--allow-host='.length);
const decision = seedDecision(config.DATABASE_URL, config.NODE_ENV, allowHost);
if (!decision.allowed) {
  process.stderr.write(`${decision.reason ?? 'Refusing to seed.'}\n`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: config.DATABASE_URL });
await client.connect();
try {
  await client.query('begin');

  const tenantIds = new Map<string, string>();
  for (const hospital of HOSPITALS) {
    const { rows } = await client.query<{ id: string }>(
      `insert into tenants (slug, name, locale, timezone, currency, theme_primary, address, phone,
                            registration_number)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (slug) do update
         set name = excluded.name, locale = excluded.locale, timezone = excluded.timezone,
             currency = excluded.currency, theme_primary = excluded.theme_primary,
             address = excluded.address, phone = excluded.phone,
             registration_number = excluded.registration_number
       returning id`,
      [
        hospital.slug,
        hospital.name,
        hospital.locale,
        hospital.timezone,
        hospital.currency,
        hospital.themePrimary,
        hospital.address,
        hospital.phone,
        hospital.registrationNumber,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`could not seed ${hospital.slug}`);
    tenantIds.set(hospital.slug, id);
    for (const [feature, enabled] of Object.entries(hospital.features)) {
      await client.query(
        `insert into tenant_features (tenant_id, feature, enabled) values ($1, $2, $3)
         on conflict (tenant_id, feature) do update set enabled = excluded.enabled`,
        [id, feature, enabled],
      );
    }
  }

  // The clinic's own role, as its admin would create it. Built-in roles come with the hospital.
  await client.query(
    `insert into roles (tenant_id, id, name) values ($1, 'billing_clerk', 'Billing clerk')
     on conflict (tenant_id, id) do nothing`,
    [tenantIds.get('riverside-clinic')],
  );

  const secretHash = await hashPassword(DEV_PASSWORD);
  for (const person of STAFF) {
    const { rows } = await client.query<{ id: string }>(
      `insert into users (email, name) values ($1, $2)
       on conflict (email) do update set name = excluded.name, updated_at = now()
       returning id`,
      [person.email, person.name],
    );
    const userId = rows[0]?.id;
    if (!userId) throw new Error(`could not seed ${person.email}`);
    await client.query(
      `insert into user_identities (user_id, provider, subject, secret_hash)
       values ($1::uuid, 'password', $1::text, $2)
       on conflict (provider, subject) do update
         set secret_hash = excluded.secret_hash, updated_at = now()`,
      [userId, secretHash],
    );
    for (const membership of person.memberships) {
      await client.query(
        `insert into memberships (tenant_id, user_id, role_id) values ($1, $2, $3)
         on conflict (tenant_id, user_id) do update
           set role_id = excluded.role_id, status = 'active', updated_at = now()`,
        [tenantIds.get(membership.slug), userId, membership.roleId],
      );
    }
  }

  // Sample departments. Only names the hospital does not have yet, so running again adds nothing.
  for (const hospital of HOSPITALS) {
    await client.query(
      `insert into departments (tenant_id, name)
       select $1, name from unnest($2::text[]) as name
       on conflict on constraint departments_name_taken do nothing`,
      [tenantIds.get(hospital.slug), SAMPLE_DEPARTMENTS],
    );
  }

  // A price catalog, each service with last year's price and the one in force since. Only codes
  // the hospital does not have yet, so running again adds nothing.
  for (const hospital of HOSPITALS) {
    const tenantId = tenantIds.get(hospital.slug);
    const counters = new Map<string, number>();
    for (const [category, prefix, name, amount] of SAMPLE_SERVICES) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      const added = await client.query<{ id: string }>(
        `insert into services (tenant_id, code, name, category, tax_class)
         values ($1, $2, $3, $4, $5)
         on conflict on constraint services_code_taken do nothing
         returning id`,
        [
          tenantId,
          `${prefix}-${String(n).padStart(3, '0')}`,
          name,
          category,
          // Clinical services are exempt; rooms and packages carry a rate.
          category === 'bed' || category === 'package' ? 'standard' : 'exempt',
        ],
      );
      const serviceId = added.rows[0]?.id;
      if (!serviceId || amount === 0) continue;
      await client.query(
        `insert into service_prices
           (tenant_id, service_id, price_list_id, amount_minor, effective_from, effective_to)
         select $1, $2, l.id, p.amount, p.starts, p.ends
         from price_lists l,
           (values ($3::bigint, date '2024-04-01', date '2025-03-31'),
                   ($4::bigint, date '2025-04-01', null)) as p (amount, starts, ends)
         where l.tenant_id = $1 and l.standard`,
        [tenantId, serviceId, Math.round(amount * 0.9), amount],
      );
    }
    // Given to the imaging services that have none yet, so a hospital seeded before #96 has them.
    for (const [name, modality] of SAMPLE_MODALITIES) {
      await client.query(
        `update services set modality = $3
         where tenant_id = $1 and name = $2 and category = 'imaging' and modality is null`,
        [tenantId, name, modality],
      );
    }
  }

  // Medicines and consumables. Only items the hospital does not have yet, so running again adds
  // nothing.
  for (const hospital of HOSPITALS) {
    const tenantId = tenantIds.get(hospital.slug);
    for (const [genericName, schedule] of SAMPLE_MEDICINES) {
      for (const strength of ['250 mg', '500 mg']) {
        await client.query(
          `insert into drugs (tenant_id, type, generic_name, brand_name, form, strength, unit,
             schedule, controlled, tax_class, reorder_level)
           values ($1, 'medicine', $2, $3, 'tablet', $4, 'strip of 10', $5, $6, 'reduced', 50)
           on conflict on constraint drugs_exists do nothing`,
          [
            tenantId,
            genericName,
            `${genericName.slice(0, 4)}care`,
            strength,
            schedule,
            schedule === 'x' || schedule === 'narcotic',
          ],
        );
      }
    }
    for (const genericName of SAMPLE_CONSUMABLES) {
      await client.query(
        `insert into drugs (tenant_id, type, generic_name, form, unit, schedule, tax_class)
         values ($1, 'consumable', $2, 'device', 'piece', 'none', 'standard')
         on conflict on constraint drugs_exists do nothing`,
        [tenantId, genericName],
      );
    }
  }

  // Lab tests and panels, a test charged as a laboratory service where the hospital has one of
  // that name. Only codes the hospital does not have yet, so running again adds nothing.
  for (const hospital of HOSPITALS) {
    const tenantId = tenantIds.get(hospital.slug);
    const addTest = async (
      values: [string, string, string, string, string, string, number, string | null],
      resultType: string,
      service: string | null,
    ) => {
      const added = await client.query<{ id: string }>(
        `insert into lab_tests (tenant_id, code, name, department, kind, sample_type, container,
           turnaround_hours, unit, result_type, service_id)
         select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           (select id from services
            where tenant_id = $1 and name = $11 and category = 'lab' limit 1)
         on conflict on constraint lab_tests_code_taken do nothing
         returning id`,
        [tenantId, ...values, resultType, service],
      );
      return added.rows[0]?.id;
    };
    for (const [code, name, section, sample, container, hours, unit, service] of SAMPLE_LAB_TESTS) {
      const id = await addTest(
        [code, name, section, 'test', sample, container, hours, unit],
        unit === null ? 'text' : 'numeric',
        service,
      );
      if (!id) continue;
      for (const [position, row] of (SAMPLE_LAB_RANGES[code] ?? []).entries()) {
        await client.query(
          `insert into lab_test_ranges (tenant_id, lab_test_id, position, sex, age_from_value,
             age_from_unit, age_until_value, age_until_unit, low, high, critical_low, critical_high)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [tenantId, id, position, ...row],
        );
      }
    }
    for (const [
      code,
      name,
      section,
      sample,
      container,
      hours,
      service,
      parts,
    ] of SAMPLE_LAB_PANELS) {
      const id = await addTest(
        [code, name, section, 'panel', sample, container, hours, null],
        'text',
        service,
      );
      if (!id) continue;
      await client.query(
        `insert into lab_test_components (tenant_id, panel_id, component_id, position)
         select $1, $2, t.id, part.position - 1
         from unnest($3::text[]) with ordinality as part (code, position)
         join lab_tests t on t.tenant_id = $1 and t.code = part.code and t.kind = 'test'`,
        [tenantId, id, parts],
      );
    }
  }

  // Bed categories, then wards with their rooms and beds. Only names and codes the hospital does
  // not have yet, so running again adds nothing.
  for (const hospital of HOSPITALS) {
    const tenantId = tenantIds.get(hospital.slug);
    for (const [name, service] of SAMPLE_BED_CATEGORIES) {
      await client.query(
        `insert into bed_categories (tenant_id, name, service_id)
         select $1, $2,
           (select id from services
            where tenant_id = $1 and name = $3 and category = 'bed' limit 1)
         on conflict on constraint bed_categories_name_taken do nothing`,
        [tenantId, name, service],
      );
    }
    for (const [code, name, floor, department, rooms] of SAMPLE_WARDS) {
      const added = await client.query<{ id: string }>(
        `insert into wards (tenant_id, code, name, floor, department_id)
         select $1, $2, $3, $4,
           (select id from departments where tenant_id = $1 and name = $5 limit 1)
         on conflict on constraint wards_code_taken do nothing
         returning id`,
        [tenantId, code, name, floor, department],
      );
      const wardId = added.rows[0]?.id;
      if (!wardId) continue;
      for (const [roomName, category, numbers] of rooms) {
        const room = await client.query<{ id: string }>(
          'insert into rooms (tenant_id, ward_id, name) values ($1, $2, $3) returning id',
          [tenantId, wardId, roomName],
        );
        await client.query(
          `insert into beds (tenant_id, ward_id, room_id, number, bed_category_id)
           select $1, $2, $3, number, c.id
           from unnest($4::text[]) as number
           join bed_categories c on c.tenant_id = $1 and c.name = $5`,
          [tenantId, wardId, room.rows[0]?.id, numbers, category],
        );
      }
    }
    // One bed out of use and one being made ready, so the screen shows every status but occupied.
    await client.query(
      `update beds set status = 'blocked', blocked_reason = 'repair'
       where tenant_id = $1 and number = 'ICU-4' and status = 'available' and version = 1
         and ward_id = (select id from wards where tenant_id = $1 and code = 'ICU')`,
      [tenantId],
    );
    await client.query(
      `update beds set status = 'cleaning'
       where tenant_id = $1 and number = 'G-08' and status = 'available' and version = 1
         and ward_id = (select id from wards where tenant_id = $1 and code = 'GEN')`,
      [tenantId],
    );
  }

  // The sample code sets, shared by every hospital, and a few favourites for each. A sample is
  // loaded only into an empty set (#316): loaded over a real set on a developer's machine, it
  // would change the titles of the codes the two share to the sample's wording. A favourite that
  // is marked already stays as it is.
  for (const [system, file] of SAMPLE_CODE_FILES) {
    const loaded = await client.query('select 1 from codes where system = $1 limit 1', [system]);
    if (loaded.rowCount) continue;
    const bytes = readFileSync(fileURLToPath(new URL(`../sample-codes/${file}`, import.meta.url)));
    await loadCodes(client, system, bytes.toString('utf8'), fileSha256(bytes));
  }
  for (const hospital of HOSPITALS) {
    await client.query(
      `insert into code_favourites (tenant_id, code_id)
       select $1, id from codes where code = any($2::text[])
       on conflict do nothing`,
      [tenantIds.get(hospital.slug), SAMPLE_FAVOURITE_CODES],
    );
  }

  // Sample templates, each as its version 1, saved by a member of the hospital's staff. Only for
  // a hospital that has none, so running the seed again adds nothing.
  for (const hospital of HOSPITALS) {
    const tenantId = tenantIds.get(hospital.slug);
    const existing = await client.query('select 1 from templates where tenant_id = $1 limit 1', [
      tenantId,
    ]);
    const author = await client.query<{ user_id: string }>(
      `select user_id from memberships where tenant_id = $1 order by (role_id = 'admin') desc, user_id limit 1`,
      [tenantId],
    );
    const savedBy = author.rows[0]?.user_id;
    if ((existing.rowCount ?? 0) > 0 || !savedBy) continue;
    for (const template of SAMPLE_TEMPLATES) {
      const body = {
        type: 'doc',
        content: template.lines.map((line) => ({
          type: 'paragraph',
          content: [{ type: 'text', text: line }],
        })),
      };
      const added = await client.query<{ id: string }>(
        'insert into templates (tenant_id, kind, name, saved_at) values ($1, $2, $3, now()) returning id',
        [tenantId, template.kind, template.name],
      );
      await client.query(
        `insert into template_versions (tenant_id, template_id, version, name, body, saved_at, saved_by)
         values ($1, $2, 1, $3, $4::jsonb, now(), $5)`,
        [tenantId, added.rows[0]?.id, template.name, JSON.stringify(body), savedBy],
      );
    }
  }

  // A doctor profile, with weekday morning hours, for every sample member in the doctor role who
  // has none: so the doctors screen has something to show. Running again adds nothing.
  for (const hospital of HOSPITALS) {
    const tenantId = tenantIds.get(hospital.slug);
    const added = await client.query<{ id: string }>(
      `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
       select m.tenant_id, m.user_id,
              p.id, 'General practice', 15
       from memberships m
       -- Whatever its capitals now. A hospital that has no such department gets no profiles.
       join departments p on p.tenant_id = m.tenant_id and p.name_lower = 'general medicine'
       where m.tenant_id = $1 and m.role_id = 'doctor'
       on conflict on constraint doctors_one_profile do nothing
       returning id`,
      [tenantId],
    );
    // A registration number made from the person's id, so each differs. Only on profiles with
    // neither qualifications nor a council (a database seeded before #397), and an existing
    // registration number is kept; a profile left without them on purpose gets them too.
    await client.query(
      `update doctors
       set qualifications = $2, registration_council = $3,
           registration_number = coalesce(registration_number,
                                          'REG-' || upper(left(user_id::text, 6)))
       where tenant_id = $1 and qualifications is null and registration_council is null`,
      [
        tenantId,
        hospital.doctorCredentials.qualifications,
        hospital.doctorCredentials.registrationCouncil,
      ],
    );
    for (const doctor of added.rows) {
      await client.query(
        `insert into doctor_hours (tenant_id, doctor_id, day, start_minute, end_minute)
         select $1, $2, day, 540, 780 from generate_series(1, 5) as day`,
        [tenantId, doctor.id],
      );
    }
  }

  // Synthetic patients, so the patient screens have something to show against the real API.
  // Only for a hospital that has none, so running the seed again changes nothing.
  for (const hospital of HOSPITALS) {
    const tenantId = tenantIds.get(hospital.slug);
    const existing = await client.query('select 1 from patients where tenant_id = $1 limit 1', [
      tenantId,
    ]);
    if (existing.rowCount !== 0) continue;
    await client.query(
      `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, email,
         contact_consent_given, contact_consent_at, contact_consent_recorded_by, created_by)
       select $1, $2 || '-' || lpad(n::text, $6::int, '0'),
              ($3::text[])[1 + n % array_length($3::text[], 1)],
              ($4::text[])[1 + (n * 7) % array_length($4::text[], 1)],
              date '1945-01-01' + (n * 311) % 27000,
              (array['female', 'male', 'other'])[1 + n % 3],
              '+91 98' || lpad((n * 104729 % 100000000)::text, 8, '0'),
              'patient' || n || '@example.test',
              n % 4 <> 0, now(), 'seed', 'seed'
       from generate_series(1, $5::int) as n`,
      [
        tenantId,
        mrnPrefix(hospital.slug),
        SAMPLE_FIRST_NAMES,
        SAMPLE_LAST_NAMES,
        SAMPLE_PATIENTS,
        MRN_DIGITS,
      ],
    );
    await client.query(
      `insert into patient_mrn_counters (tenant_id, last_value) values ($1, $2)
       on conflict (tenant_id) do update set last_value = excluded.last_value`,
      [tenantId, SAMPLE_PATIENTS],
    );
  }

  // Appointments from three days ago to a week ahead at each hospital, every other slot of each
  // practising doctor's hours: the past ones completed or a no-show, a few cancelled, the rest
  // scheduled. Only for a hospital that has none, so running the seed again changes nothing.
  for (const hospital of HOSPITALS) {
    const tenantId = tenantIds.get(hospital.slug);
    const existing = await client.query('select 1 from appointments where tenant_id = $1 limit 1', [
      tenantId,
    ]);
    if (existing.rowCount !== 0) continue;
    await client.query(
      `insert into appointments (tenant_id, patient_id, doctor_id, starts_at, ends_at, status,
         cancel_reason, created_by)
       select $1, p.id, d.id, s.starts_at, s.starts_at + make_interval(mins => d.consultation_minutes),
              v.status, case when v.status = 'cancelled' then 'patient_request' end, 'seed'
       from tenants t
       cross join (
         select d.id, d.consultation_minutes, row_number() over (order by d.id) as rn
         from doctors d join memberships m on m.tenant_id = d.tenant_id and m.user_id = d.user_id
         where d.tenant_id = $1 and d.active and m.status = 'active'
       ) d
       cross join generate_series(-3, 7) as g(shift)
       cross join lateral (select (now() at time zone t.timezone)::date + g.shift as day) dd
       join doctor_hours h on h.doctor_id = d.id and h.day = extract(isodow from dd.day)
       cross join lateral generate_series(h.start_minute::int,
         h.end_minute::int - d.consultation_minutes, d.consultation_minutes * 2)
         with ordinality as n(minute, k)
       cross join lateral (
         select (dd.day + make_interval(mins => n.minute))::timestamp at time zone t.timezone
           as starts_at
       ) s
       -- A different patient for each doctor at the same time: 37 shares no factor with the count.
       cross join lateral (
         select id from patients where tenant_id = $1 order by mrn
         offset (d.rn * 37 + (g.shift + 3) * 11 + n.k) % $2 limit 1
       ) p
       cross join lateral (
         select case
           when s.starts_at + make_interval(mins => d.consultation_minutes) <= now()
             then case when (n.k + d.rn) % 7 = 0 then 'no_show' else 'completed' end
           when (n.k + d.rn) % 9 = 0 then 'cancelled'
           else 'scheduled'
         end as status
       ) v
       where t.id = $1
       on conflict do nothing`,
      [tenantId, SAMPLE_PATIENTS],
    );
  }

  // Today's OPD queue at each hospital: five tokens in General Medicine, two of them for its
  // first doctor and one with a priority. Only while the hospital has none today, so running the
  // seed again the same day changes nothing.
  for (const hospital of HOSPITALS) {
    const tenantId = tenantIds.get(hospital.slug);
    const existing = await client.query(
      `select 1 from queue_tokens q join tenants t on t.id = q.tenant_id
       where q.tenant_id = $1 and q.day = (now() at time zone t.timezone)::date limit 1`,
      [tenantId],
    );
    if (existing.rowCount !== 0) continue;
    await client.query(
      `with place as (
         select t.id as tenant_id, (now() at time zone t.timezone)::date as day, d.id as department_id,
                (select o.id from doctors o where o.tenant_id = t.id and o.department_id = d.id
                 and o.active order by o.id limit 1) as doctor_id
         from tenants t join departments d on d.tenant_id = t.id and d.name_lower = 'general medicine'
         where t.id = $1
       ),
       counter as (
         insert into queue_counters (tenant_id, department_id, day, last_number)
         select tenant_id, department_id, day, 5 from place
         on conflict (tenant_id, department_id, day) do nothing
         returning tenant_id
       )
       insert into queue_tokens (tenant_id, day, department_id, number, doctor_id, patient_id,
         priority, issued_at, issued_by)
       select pl.tenant_id, pl.day, pl.department_id, n,
              case when n in (1, 3) then pl.doctor_id end,
              (select id from patients where tenant_id = pl.tenant_id order by mrn offset 40 + n limit 1),
              case when n = 4 then 'senior_citizen' end,
              now() - make_interval(mins => (6 - n) * 7),
              (select user_id from memberships where tenant_id = pl.tenant_id order by user_id limit 1)
       from place pl cross join counter cross join generate_series(1, 5) as n`,
      [tenantId],
    );
  }

  // The clinic's own normal ranges: it marks a temperature high a little sooner. The hospital has
  // none, so it uses the API's built-in ones.
  await client.query(
    `insert into vital_ranges (tenant_id, measure, low, high)
     values ($1, 'systolic', 90, 139), ($1, 'diastolic', 60, 89), ($1, 'pulse', 60, 100),
            ($1, 'temperature', 36.1, 37.5), ($1, 'spo2', 94, null)
     on conflict (tenant_id, measure) do nothing`,
    [tenantIds.get('riverside-clinic')],
  );

  await client.query('commit');

  // Built-in roles get the default permissions the features declare, as a deploy does.
  const app = await buildApp({ ...config, LOG_LEVEL: 'silent' });
  try {
    await app.ready();
    await syncRoleDefaults(client, app.permissions.all());
  } finally {
    await app.close();
  }
  process.stdout.write(
    `Seeded ${HOSPITALS.length} hospitals and ${STAFF.length} staff.\n` +
      `Sign in as any of:\n${STAFF.map((person) => `  ${person.email}`).join('\n')}\n` +
      `Password: ${DEV_PASSWORD}\n`,
  );
} catch (error) {
  await client.query('rollback');
  process.stderr.write(`${error instanceof Error ? error.message : 'Seeding failed.'}\n`);
  process.exitCode = 1;
} finally {
  await client.end();
}
