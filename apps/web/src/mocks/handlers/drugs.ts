import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';

type Drug = components['schemas']['Drug'];
type DrugPage = components['schemas']['DrugPage'];
type Form = Drug['form'];
type Schedule = Drug['schedule'];

const FEATURE_FLAG = 'drugs';
const READ = 'drug:read';
const MANAGE = 'drug:manage';

const TYPES: readonly Drug['type'][] = ['medicine', 'consumable'];
const FORMS: readonly Form[] = [
  'tablet',
  'capsule',
  'syrup',
  'suspension',
  'injection',
  'infusion',
  'cream',
  'ointment',
  'drops',
  'inhaler',
  'powder',
  'device',
  'other',
];
const SCHEDULES: readonly Schedule[] = ['none', 'h', 'h1', 'x', 'g', 'narcotic'];
const TAX_CLASSES: readonly Drug['taxClass'][] = ['exempt', 'reduced', 'standard', 'higher'];

/** Generic names with the schedule each falls under. Synthetic: not a formulary. */
const GENERICS: [string, Schedule][] = [
  ['Aceclofenac', 'h'],
  ['Albendazole', 'h'],
  ['Alprazolam', 'x'],
  ['Amlodipine', 'h'],
  ['Amoxicillin', 'h'],
  ['Atenolol', 'h'],
  ['Atorvastatin', 'h'],
  ['Azithromycin', 'h'],
  ['Cefixime', 'h1'],
  ['Ceftriaxone', 'h1'],
  ['Cetirizine', 'none'],
  ['Ciprofloxacin', 'h'],
  ['Clopidogrel', 'h'],
  ['Diclofenac', 'h'],
  ['Domperidone', 'h'],
  ['Doxycycline', 'h'],
  ['Enalapril', 'h'],
  ['Fluconazole', 'h'],
  ['Furosemide', 'h'],
  ['Glimepiride', 'g'],
  ['Ibuprofen', 'none'],
  ['Insulin', 'g'],
  ['Levocetirizine', 'none'],
  ['Levofloxacin', 'h1'],
  ['Losartan', 'h'],
  ['Metformin', 'g'],
  ['Metoprolol', 'h'],
  ['Metronidazole', 'h'],
  ['Morphine', 'narcotic'],
  ['Omeprazole', 'h'],
  ['Ondansetron', 'h'],
  ['Pantoprazole', 'h'],
  ['Paracetamol', 'none'],
  ['Prednisolone', 'h'],
  ['Ranitidine', 'h'],
  ['Salbutamol', 'h'],
  ['Telmisartan', 'h'],
  ['Tramadol', 'h1'],
  ['Vitamin B complex', 'none'],
  ['Zinc sulphate', 'none'],
];
const SHAPES: [Form, string][] = [
  ['tablet', 'strip of 10'],
  ['capsule', 'strip of 10'],
  ['syrup', '100 ml bottle'],
  ['injection', 'vial'],
];
const STRENGTHS = ['5 mg', '10 mg', '250 mg', '500 mg', '650 mg'];
const BRANDS = ['Care', 'Med', 'Plus', 'Fort'];
const CONSUMABLES = [
  'Examination gloves',
  'Surgical gloves',
  'Syringe 2 ml',
  'Syringe 5 ml',
  'IV cannula 20G',
  'IV set',
  'Cotton roll',
  'Gauze swab',
  'Surgical mask',
  'Micropore tape',
];

interface State {
  drugs: Drug[];
  created: number;
  /** What each Idempotency-Key was answered with, by hospital and key. */
  replies: Map<string, { raw: string; drug: Drug }>;
}

/** About three thousand items at the hospital, so search and paging work on a real catalog. */
function seed(): State {
  const drugs: Drug[] = [];
  const id = (prefix: string) => `${prefix}_${String(drugs.length + 1).padStart(4, '0')}`;
  for (const [genericName, schedule] of GENERICS) {
    for (const [form, unit] of SHAPES) {
      for (const strength of STRENGTHS) {
        for (const brand of BRANDS) {
          drugs.push({
            id: id('drg_h'),
            tenantId: TENANT_IDS.hospital,
            type: 'medicine',
            genericName,
            brandName: `${genericName.slice(0, 4)}${brand}`,
            form,
            strength,
            unit,
            schedule,
            controlled: schedule === 'x' || schedule === 'narcotic',
            taxClass: 'reduced',
            reorderLevel: 50,
            archived: false,
            version: 1,
          });
        }
      }
    }
  }
  for (const genericName of CONSUMABLES) {
    drugs.push({
      id: id('drg_h'),
      tenantId: TENANT_IDS.hospital,
      type: 'consumable',
      genericName,
      form: 'device',
      unit: 'piece',
      schedule: 'none',
      controlled: false,
      taxClass: 'standard',
      archived: false,
      version: 1,
    });
  }
  drugs.push({
    id: 'drg_h_old',
    tenantId: TENANT_IDS.hospital,
    type: 'medicine',
    genericName: 'Withdrawn syrup',
    form: 'syrup',
    schedule: 'none',
    controlled: false,
    taxClass: 'reduced',
    archived: true,
    version: 2,
  });
  for (const [index, genericName] of ['Paracetamol', 'Amoxicillin', 'Surgical mask'].entries()) {
    drugs.push({
      id: `drg_c_${index + 1}`,
      tenantId: TENANT_IDS.clinic,
      type: index === 2 ? 'consumable' : 'medicine',
      genericName,
      form: index === 2 ? 'device' : 'tablet',
      ...(index === 2 ? {} : { strength: '500 mg' }),
      schedule: index === 1 ? 'h' : 'none',
      controlled: false,
      taxClass: 'reduced',
      archived: false,
      version: 1,
    });
  }
  return { drugs, created: 0, replies: new Map() };
}

let state = seed();
onMockReset(() => {
  state = seed();
});

/** What another member of staff does meanwhile: changes an item behind the open screen. */
export function editMockDrug(id: string, changes: Partial<Drug>): void {
  const drug = state.drugs.find((candidate) => candidate.id === id);
  if (!drug) throw new Error(`Unknown mock drug: ${id}`);
  Object.assign(drug, changes, { version: drug.version + 1 });
}

const invalid = () => error(400, 'validation_failed', 'The request is not valid');
const notFound = () => error(404, 'drug_not_found', 'No such item');
const exists = () => error(409, 'drug_exists', 'The hospital has exactly this item');

/** An item of another hospital does not exist as far as this session is concerned. */
const find = (tenantId: string, id: unknown) =>
  state.drugs.find((candidate) => candidate.id === id && candidate.tenantId === tenantId);

const lower = (text: string | undefined) => (text ?? '').toLowerCase();

/** The same item: generic name, brand, form and strength, whatever the capitals. */
const same = (a: Drug, b: Drug) =>
  a.tenantId === b.tenantId &&
  lower(a.genericName) === lower(b.genericName) &&
  lower(a.brandName) === lower(b.brandName) &&
  a.form === b.form &&
  lower(a.strength) === lower(b.strength);

// One collator for every comparison: a new one per comparison made each list request take a
// fifth of a second on a catalog of three thousand.
const collator = new Intl.Collator('en', { sensitivity: 'base' });
const byName = (a: Drug, b: Drug) =>
  collator.compare(a.genericName, b.genericName) ||
  collator.compare(a.brandName ?? '', b.brandName ?? '') ||
  a.id.localeCompare(b.id);

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
}

const oneOf = <Value extends string>(values: readonly Value[], value: unknown) =>
  values.find((candidate) => candidate === value);

/**
 * The fields of a body laid over an item, checked as the API's schema would. Empty text removes
 * an optional field, and null removes the reorder level. Null when not acceptable.
 */
function applied(base: Drug, body: Record<string, unknown>): Drug | null {
  const next: Drug = { ...base };
  const text = (key: 'brandName' | 'strength' | 'unit', max: number): boolean => {
    const value = body[key];
    if (value === undefined) return true;
    if (typeof value !== 'string' || value.trim().length > max) return false;
    if (value.trim()) next[key] = value.trim();
    else delete next[key];
    return true;
  };
  if (body.type !== undefined) {
    const type = oneOf(TYPES, body.type);
    if (!type) return null;
    next.type = type;
  }
  if (body.genericName !== undefined) {
    const name = body.genericName;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 150) return null;
    next.genericName = name.trim();
  }
  if (!text('brandName', 150) || !text('strength', 30) || !text('unit', 30)) return null;
  if (body.form !== undefined) {
    const form = oneOf(FORMS, body.form);
    if (!form) return null;
    next.form = form;
  }
  if (body.schedule !== undefined) {
    const schedule = oneOf(SCHEDULES, body.schedule);
    if (!schedule) return null;
    next.schedule = schedule;
  }
  if (body.taxClass !== undefined) {
    const taxClass = oneOf(TAX_CLASSES, body.taxClass);
    if (!taxClass) return null;
    next.taxClass = taxClass;
  }
  if (body.controlled !== undefined) {
    if (typeof body.controlled !== 'boolean') return null;
    next.controlled = body.controlled;
  }
  if (body.reorderLevel === null) delete next.reorderLevel;
  else if (body.reorderLevel !== undefined) {
    const level = body.reorderLevel;
    if (!Number.isInteger(level) || (level as number) < 0 || (level as number) > 1_000_000) {
      return null;
    }
    next.reorderLevel = level as number;
  }
  // These schedules are controlled whatever was sent.
  if (next.schedule === 'x' || next.schedule === 'narcotic') next.controlled = true;
  return next;
}

export const drugsHandlers = [
  http.get('*/api/drugs', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const params = new URL(request.url).searchParams;
    const words = (params.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const archived = params.get('archived') === 'true';
    const only = (key: string, value: string) => !params.get(key) || params.get(key) === value;
    // Tenant isolation: only rows of the session's tenant are ever considered.
    const visible = state.drugs
      .filter((drug) => drug.tenantId === access.tenantId && drug.archived === archived)
      .filter(
        (drug) =>
          only('type', drug.type) && only('form', drug.form) && only('schedule', drug.schedule),
      )
      .filter((drug) => params.get('controlled') !== 'true' || drug.controlled)
      .filter((drug) => {
        const haystack = `${drug.genericName} ${drug.brandName ?? ''}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .sort(byName);
    const limit = Math.min(Math.max(Number(params.get('limit')) || 25, 1), 100);
    const cursor = params.get('cursor');
    const start = cursor ? visible.findIndex((drug) => drug.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = visible[start + limit];
    return HttpResponse.json<DrugPage>({
      items: visible.slice(start, start + limit),
      nextCursor: next?.id ?? null,
      // With the first page only, as the contract says.
      ...(cursor ? {} : { total: visible.length }),
    });
  }),

  // Before `/drugs/:drugId`, which would otherwise take "duplicate-check" for an id.
  http.post('*/api/drugs/duplicate-check', async ({ request }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    const form = oneOf(FORMS, body?.form);
    const name = typeof body?.genericName === 'string' ? body.genericName.trim() : '';
    if (!form || !name) return invalid();
    const items = state.drugs
      .filter(
        (drug) =>
          drug.tenantId === access.tenantId &&
          drug.form === form &&
          lower(drug.genericName) === name.toLowerCase(),
      )
      .sort(byName)
      .slice(0, 10);
    return HttpResponse.json({ items });
  }),

  http.post('*/api/drugs', async ({ request }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const raw = await request.clone().text();
    // The same key with the same request is answered as before, and nothing is added again.
    const key = request.headers.get('idempotency-key');
    const earlier = key ? state.replies.get(`${access.tenantId}:${key}`) : undefined;
    if (earlier) {
      return earlier.raw === raw
        ? HttpResponse.json<Drug>(earlier.drug, {
            status: 201,
            headers: { 'Idempotent-Replayed': 'true' },
          })
        : error(422, 'idempotency_key_reuse', 'That key was used for another request');
    }
    const body = await readBody(request);
    if (
      !body ||
      !body.type ||
      !body.genericName ||
      !body.form ||
      !body.schedule ||
      !body.taxClass
    ) {
      return invalid();
    }
    const drug = applied(
      {
        id: `drg_new_${state.created + 1}`,
        tenantId: access.tenantId,
        type: 'medicine',
        genericName: '',
        form: 'other',
        schedule: 'none',
        controlled: false,
        taxClass: 'exempt',
        archived: false,
        version: 1,
      },
      body,
    );
    if (!drug) return invalid();
    if (state.drugs.some((other) => same(other, drug))) return exists();
    state.created += 1;
    state.drugs.push(drug);
    if (key) state.replies.set(`${access.tenantId}:${key}`, { raw, drug });
    return HttpResponse.json<Drug>(drug, { status: 201 });
  }),

  http.get('*/api/drugs/:drugId', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const drug = find(access.tenantId, params.drugId);
    return drug ? HttpResponse.json<Drug>(drug) : notFound();
  }),

  http.patch('*/api/drugs/:drugId', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    if (!body || typeof body.expectedVersion !== 'number') return invalid();
    const drug = find(access.tenantId, params.drugId);
    if (!drug) return notFound();
    if (drug.version !== body.expectedVersion) return error(409, 'conflict', 'It has changed');
    const next = applied(drug, body);
    if (!next) return invalid();
    if (state.drugs.some((other) => other.id !== drug.id && same(other, next))) return exists();
    // Sending what the item already has changes nothing.
    if (JSON.stringify(next) !== JSON.stringify(drug)) next.version = drug.version + 1;
    state.drugs[state.drugs.indexOf(drug)] = next;
    return HttpResponse.json<Drug>(next);
  }),

  ...(['archive', 'restore'] as const).map((action) =>
    http.post(`*/api/drugs/:drugId/${action}`, ({ request, params }) => {
      const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
      const drug = find(access.tenantId, params.drugId);
      if (!drug) return notFound();
      const archived = action === 'archive';
      // Doing it twice is harmless, so a retried request cannot fail.
      if (drug.archived !== archived) {
        drug.archived = archived;
        drug.version += 1;
      }
      return HttpResponse.json<Drug>(drug);
    }),
  ),
];
