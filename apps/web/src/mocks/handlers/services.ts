import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';

type Service = components['schemas']['Service'];
type ServicePage = components['schemas']['ServicePage'];
type ServicePrice = components['schemas']['ServicePrice'];
type ServicePricePage = components['schemas']['ServicePricePage'];
type PriceListList = components['schemas']['PriceListList'];
type Category = Service['category'];
type TaxClass = Service['taxClass'];

const FEATURE_FLAG = 'services';
const READ = 'service:read';
const MANAGE = 'service:manage';

const CATEGORIES: readonly Category[] = [
  'consultation',
  'procedure',
  'bed',
  'lab',
  'imaging',
  'package',
];
const TAX_CLASSES: readonly TaxClass[] = ['exempt', 'reduced', 'standard', 'higher'];
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_MAX = 1_000_000_000_000;

/** A scheduled price far enough ahead to be scheduled whenever the tests run. */
export const MOCK_FUTURE_DATE = '2099-01-01';

/** More than one page at the hospital, in every category. Prices in minor units. */
const CATALOG: [Category, string, string, number][] = [
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

type Stored = Omit<Service, 'currentPrice'>;

interface State {
  services: Stored[];
  prices: ServicePrice[];
  created: number;
}

const listOf = (tenantId: string) => `pl_${tenantId}`;

function seed(): State {
  const services: Stored[] = [];
  const prices: ServicePrice[] = [];
  const counters = new Map<string, number>();
  const add = (
    tenantId: string,
    prefix: string,
    [category, code, name, amount]: [Category, string, string, number],
    archived = false,
  ) => {
    const n = (counters.get(`${tenantId}${code}`) ?? 0) + 1;
    counters.set(`${tenantId}${code}`, n);
    const service: Stored = {
      id: `${prefix}_${String(services.length + 1).padStart(2, '0')}`,
      tenantId,
      code: `${code}-${String(n).padStart(3, '0')}`,
      name,
      category,
      // Clinical services are exempt; rooms and packages carry a rate.
      taxClass: category === 'bed' || category === 'package' ? 'standard' : 'exempt',
      archived,
      version: 1,
    };
    services.push(service);
    // A service set up and not priced yet has no price at all.
    if (amount === 0) return service;
    const price = (id: string, minor: number, from: string, to?: string): ServicePrice => ({
      id: `${service.id}_${id}`,
      serviceId: service.id,
      priceListId: listOf(tenantId),
      amountMinor: minor,
      effectiveFrom: from,
      ...(to ? { effectiveTo: to } : {}),
    });
    // Last year's price, and the one in force since.
    prices.push(price('p1', Math.round(amount * 0.9), '2024-04-01', '2025-03-31'));
    prices.push(price('p2', amount, '2025-04-01'));
    return service;
  };
  for (const entry of CATALOG) add(TENANT_IDS.hospital, 'svc_h', entry);
  add(TENANT_IDS.hospital, 'svc_h', ['package', 'PKG', 'Old health check', 200000], true);
  add(TENANT_IDS.clinic, 'svc_c', ['consultation', 'CON', 'General consultation', 15000]);
  add(TENANT_IDS.clinic, 'svc_c', ['procedure', 'PRO', 'Vaccination', 8000]);

  // The ECG goes up at a date that is always ahead.
  const ecg = services.find((service) => service.name === 'ECG');
  const current = prices.find((price) => price.id === `${ecg?.id}_p2`);
  if (ecg && current) {
    current.effectiveTo = '2098-12-31';
    prices.push({
      id: `${ecg.id}_p3`,
      serviceId: ecg.id,
      priceListId: listOf(ecg.tenantId),
      amountMinor: 45000,
      effectiveFrom: MOCK_FUTURE_DATE,
    });
  }
  return { services, prices, created: 0 };
}

let state = seed();
onMockReset(() => {
  state = seed();
});

/** What another member of staff does meanwhile: changes a service behind the open screen. */
export function editMockService(id: string, changes: Partial<Stored>): void {
  const service = state.services.find((candidate) => candidate.id === id);
  if (!service) throw new Error(`Unknown mock service: ${id}`);
  Object.assign(service, changes, { version: service.version + 1 });
}

/** Today at the signed-in hospital, as the API works it out. */
function today(): string {
  const timeZone = currentSession()?.activeTenant?.timezone ?? 'UTC';
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

function dayBefore(date: string): string {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

const pricesOf = (serviceId: string, priceListId: string) =>
  state.prices
    .filter((price) => price.serviceId === serviceId && price.priceListId === priceListId)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));

/** The service with the price in force today on its hospital's standard list. */
function view(service: Stored): Service {
  const now = today();
  const currentPrice = pricesOf(service.id, listOf(service.tenantId)).find(
    (price) =>
      price.effectiveFrom <= now && (price.effectiveTo === undefined || price.effectiveTo >= now),
  );
  return { ...service, ...(currentPrice ? { currentPrice } : {}) };
}

/** A price list named by the client: the hospital's own, or it does not exist. */
const listNamed = (tenantId: string, id: unknown) =>
  id === undefined || id === null || id === listOf(tenantId) ? listOf(tenantId) : null;
const noSuchList = () => error(404, 'price_list_not_found', 'No such price list');

const invalid = () => error(400, 'validation_failed', 'The request is not valid');
const notFound = () => error(404, 'service_not_found', 'No such service');

/** A service of another hospital does not exist as far as this session is concerned. */
const find = (tenantId: string, id: unknown) =>
  state.services.find((candidate) => candidate.id === id && candidate.tenantId === tenantId);

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
}

/** The detail fields of a body, checked as the API's schema would. Null when not acceptable. */
function readDetails(body: Record<string, unknown>): Partial<Stored> | null {
  const fields: Partial<Stored> = {};
  const { name, category, taxClass, description } = body;
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 150) return null;
    fields.name = name.trim();
  }
  if (category !== undefined) {
    const known = CATEGORIES.find((value) => value === category);
    if (!known) return null;
    fields.category = known;
  }
  if (taxClass !== undefined) {
    const known = TAX_CLASSES.find((value) => value === taxClass);
    if (!known) return null;
    fields.taxClass = known;
  }
  if (description !== undefined) {
    if (typeof description !== 'string' || description.length > 500) return null;
    fields.description = description.trim();
  }
  return fields;
}

const isAmount = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= AMOUNT_MAX;

function paged<T>(request: Request, all: T[], idOf: (item: T) => string) {
  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit') ?? 25), 1), 100);
  const cursor = params.get('cursor');
  const start = cursor ? all.findIndex((item) => idOf(item) === cursor) : 0;
  if (start < 0) return null;
  const next = all[start + limit];
  return {
    items: all.slice(start, start + limit),
    nextCursor: next ? idOf(next) : null,
    total: all.length,
  };
}

export const servicesHandlers = [
  http.get('*/api/price-lists', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    return HttpResponse.json<PriceListList>({
      items: [{ id: listOf(access.tenantId), name: 'Standard', standard: true }],
    });
  }),

  http.get('*/api/services', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const params = new URL(request.url).searchParams;
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const category = params.get('category');
    const archived = params.get('archived') === 'true';
    // Tenant isolation: only rows of the session's tenant are ever considered.
    const visible = state.services
      .filter((service) => service.tenantId === access.tenantId && service.archived === archived)
      .filter((service) => !category || service.category === category)
      .filter((service) => `${service.code} ${service.name}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
      .map(view);
    const page = paged(request, visible, (service) => service.id);
    if (!page) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json<ServicePage>(page);
  }),

  http.post('*/api/services', async ({ request }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    const fields = body && readDetails(body);
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!fields?.name || !fields.category || !fields.taxClass) return invalid();
    if (!CODE.test(code) || code.length > 30) return invalid();
    if (body?.priceMinor !== undefined && !isAmount(body.priceMinor)) return invalid();
    const taken = state.services.some(
      (service) =>
        service.tenantId === access.tenantId && service.code.toLowerCase() === code.toLowerCase(),
    );
    if (taken) return error(409, 'service_code_taken', 'A service has that code');
    const service: Stored = {
      id: `svc_new_${++state.created}`,
      tenantId: access.tenantId,
      code,
      name: fields.name,
      category: fields.category,
      taxClass: fields.taxClass,
      ...(fields.description ? { description: fields.description } : {}),
      archived: false,
      version: 1,
    };
    state.services.push(service);
    if (isAmount(body?.priceMinor)) {
      state.prices.push({
        id: `${service.id}_p1`,
        serviceId: service.id,
        priceListId: listOf(access.tenantId),
        amountMinor: body.priceMinor,
        effectiveFrom: today(),
      });
    }
    return HttpResponse.json<Service>(view(service), { status: 201 });
  }),

  http.get('*/api/services/:serviceId', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const service = find(access.tenantId, params.serviceId);
    return service ? HttpResponse.json<Service>(view(service)) : notFound();
  }),

  http.patch('*/api/services/:serviceId', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    const fields = body && readDetails(body);
    // The code is a service's identity on bills: it is not one of the things that change.
    if (!body || !fields || 'code' in body || typeof body.expectedVersion !== 'number') {
      return invalid();
    }
    const service = find(access.tenantId, params.serviceId);
    if (!service) return notFound();
    if (service.version !== body.expectedVersion) {
      return error(409, 'conflict', 'The service has changed');
    }
    const before = JSON.stringify(service);
    Object.assign(service, fields);
    if (service.description === '') delete service.description;
    // Sending what the service already has changes nothing.
    if (JSON.stringify(service) !== before) service.version += 1;
    return HttpResponse.json<Service>(view(service));
  }),

  ...(['archive', 'restore'] as const).map((action) =>
    http.post(`*/api/services/:serviceId/${action}`, ({ request, params }) => {
      const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
      const service = find(access.tenantId, params.serviceId);
      if (!service) return notFound();
      const archived = action === 'archive';
      // Doing it twice is harmless, so a retried request cannot fail.
      if (service.archived !== archived) {
        service.archived = archived;
        service.version += 1;
      }
      return HttpResponse.json<Service>(view(service));
    }),
  ),

  http.get('*/api/services/:serviceId/prices', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const service = find(access.tenantId, params.serviceId);
    if (!service) return notFound();
    const priceListId = listNamed(
      access.tenantId,
      new URL(request.url).searchParams.get('priceListId'),
    );
    if (!priceListId) return noSuchList();
    const page = paged(request, pricesOf(service.id, priceListId), (price) => price.id);
    if (!page) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json<ServicePricePage>(page);
  }),

  http.post('*/api/services/:serviceId/prices', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    const from = body?.effectiveFrom;
    if (!body || !isAmount(body.amountMinor) || typeof from !== 'string' || !DATE.test(from)) {
      return invalid();
    }
    const service = find(access.tenantId, params.serviceId);
    if (!service) return notFound();
    if (service.archived)
      return error(409, 'service_archived', 'An archived service is not priced');
    const priceListId = listNamed(access.tenantId, body.priceListId);
    if (!priceListId) return noSuchList();
    const now = today();
    const existing = pricesOf(service.id, priceListId);
    const latest = existing[0];
    // At most one price is scheduled at a time.
    if (latest && latest.effectiveFrom > now) {
      return error(409, 'price_date_conflict', 'A price is already scheduled');
    }
    // The first price may start today. Once one is in force, a new one starts tomorrow or
    // later: charges posted this morning used the price in force, and that is not rewritten.
    if (latest ? from <= now : from < now) return invalid();
    // The price before it ends the day before. Nothing else about it changes.
    if (latest) latest.effectiveTo = dayBefore(from);
    const price: ServicePrice = {
      id: `${service.id}_n${++state.created}`,
      serviceId: service.id,
      priceListId,
      amountMinor: body.amountMinor,
      effectiveFrom: from,
    };
    state.prices.push(price);
    return HttpResponse.json<ServicePrice>(price, { status: 201 });
  }),

  http.delete('*/api/services/:serviceId/prices/:priceId', ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const service = find(access.tenantId, params.serviceId);
    if (!service) return notFound();
    const price = state.prices.find(
      (candidate) => candidate.id === params.priceId && candidate.serviceId === service.id,
    );
    if (!price) return error(404, 'price_not_found', 'No such price');
    if (price.effectiveFrom <= today()) {
      return error(409, 'price_in_force', 'A price that is or was in force is not withdrawn');
    }
    state.prices = state.prices.filter((candidate) => candidate !== price);
    // Only the latest price can be a scheduled one, so the one before it is the one in
    // force: it carries on with no end date.
    const before = pricesOf(service.id, price.priceListId)[0];
    if (before) delete before.effectiveTo;
    return new HttpResponse(null, { status: 204 });
  }),
];
