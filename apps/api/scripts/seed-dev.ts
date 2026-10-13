// Run with `pnpm --filter api db:seed`. Development only.
//
// Fills the local database with the same two sample hospitals and four sample staff the web
// app's mock API has, so the real API can be signed in to. Synthetic data only. Safe to run
// again: existing rows are updated in place.
import pg from 'pg';
import { MRN_DIGITS, mrnPrefix } from '../src/features/patients/repository.js';
import { buildApp } from '../src/app.js';
import { syncRoleDefaults } from '../src/core/access/sync.js';
import { hashPassword } from '../src/core/auth/password.js';
import { loadConfig } from '../src/core/config/config.js';
import { seedDecision } from '../src/core/db/seed-guard.js';

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

const HOSPITALS = [
  {
    slug: 'sample-hospital',
    name: 'Sample Hospital',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    themePrimary: '#0f766e',
    features: {
      patients: true,
      departments: true,
      doctors: true,
      staff: true,
      services: true,
      drugs: true,
      lab_tests: true,
      wards: true,
      appointments: true,
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
    features: {
      patients: true,
      departments: true,
      doctors: true,
      staff: true,
      services: true,
      drugs: true,
      lab_tests: true,
      wards: true,
      appointments: true,
      clinical: true,
      laboratory: false,
      radiology: false,
      pharmacy: false,
      billing: true,
      reports: false,
    },
  },
] as const;

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
      `insert into tenants (slug, name, locale, timezone, currency, theme_primary)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (slug) do update
         set name = excluded.name, locale = excluded.locale, timezone = excluded.timezone,
             currency = excluded.currency, theme_primary = excluded.theme_primary
       returning id`,
      [
        hospital.slug,
        hospital.name,
        hospital.locale,
        hospital.timezone,
        hospital.currency,
        hospital.themePrimary,
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
       where tenant_id = $1 and number = 'ICU-4' and status = 'available' and version = 1`,
      [tenantId],
    );
    await client.query(
      `update beds set status = 'cleaning'
       where tenant_id = $1 and number = 'G-08' and status = 'available' and version = 1`,
      [tenantId],
    );
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
