import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';

type Department = components['schemas']['Department'];
type DepartmentPage = components['schemas']['DepartmentPage'];

const FEATURE_FLAG = 'departments';
const READ = 'department:read';
const MANAGE = 'department:manage';

/** More than one page at the hospital, so paging is exercised. */
const HOSPITAL = [
  'Anaesthesiology',
  'Cardiology',
  'Dentistry',
  'Dermatology',
  'Emergency',
  'Endocrinology',
  'ENT',
  'Gastroenterology',
  'General Medicine',
  'General Surgery',
  'Gynaecology',
  'Haematology',
  'Intensive Care',
  'Laboratory',
  'Nephrology',
  'Neurology',
  'Obstetrics',
  'Oncology',
  'Ophthalmology',
  'Orthopaedics',
  'Paediatrics',
  'Pharmacy',
  'Physiotherapy',
  'Psychiatry',
  'Pulmonology',
  'Radiology',
  'Rheumatology',
  'Urology',
];
const CLINIC = ['Family Medicine', 'Paediatrics'];

function seed(): Department[] {
  const build = (tenantId: string, prefix: string, names: string[]): Department[] =>
    names.map((name, index) => ({
      id: `${prefix}_${String(index + 1).padStart(2, '0')}`,
      tenantId,
      name,
      archived: false,
      version: 1,
    }));
  return [
    ...build(TENANT_IDS.hospital, 'dep_h', HOSPITAL),
    ...build(TENANT_IDS.clinic, 'dep_c', CLINIC),
    {
      id: 'dep_h_old',
      tenantId: TENANT_IDS.hospital,
      name: 'Homeopathy',
      description: 'Closed in 2025.',
      archived: true,
      version: 2,
    },
  ];
}

let departments = seed();
let created = 0;
onMockReset(() => {
  departments = seed();
  created = 0;
});

/** What another member of staff does meanwhile: changes a department behind the open screen. */
export function editMockDepartment(id: string, changes: Partial<Department>): void {
  const department = departments.find((candidate) => candidate.id === id);
  if (!department) throw new Error(`Unknown mock department: ${id}`);
  Object.assign(department, changes, { version: department.version + 1 });
}

const byName = (a: Department, b: Department) =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/** A name is one department per hospital, whatever its capitals, archived or not. */
const nameTaken = (tenantId: string, name: string, exceptId?: string) =>
  departments.some(
    (candidate) =>
      candidate.tenantId === tenantId &&
      candidate.id !== exceptId &&
      candidate.name.toLowerCase() === name.toLowerCase(),
  );

interface Fields {
  name?: string;
  description?: string;
  expectedVersion?: number;
}

/** The body, checked as the API's schema would. Null when it is not acceptable. */
async function readFields(request: Request, nameRequired: boolean): Promise<Fields | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null) return null;
  const { name, description, expectedVersion } = body as Record<string, unknown>;
  const fields: Fields = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim() === '' || name.length > 100) return null;
    fields.name = name.trim();
  } else if (nameRequired) return null;
  if (description !== undefined) {
    if (typeof description !== 'string' || description.length > 500) return null;
    fields.description = description.trim();
  }
  if (expectedVersion !== undefined) {
    if (typeof expectedVersion !== 'number') return null;
    fields.expectedVersion = expectedVersion;
  }
  return fields;
}

const invalid = () => error(400, 'validation_failed', 'The request is not valid');
const notFound = () => error(404, 'department_not_found', 'No such department');
const taken = () => error(409, 'department_name_taken', 'A department has that name');

/** A department of another hospital does not exist as far as this session is concerned. */
const find = (tenantId: string, id: unknown) =>
  departments.find((candidate) => candidate.id === id && candidate.tenantId === tenantId);

export const departmentsHandlers = [
  http.get('*/api/departments', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 25), 1), 100);
    const cursor = url.searchParams.get('cursor');
    const archived = url.searchParams.get('archived') === 'true';
    // Tenant isolation: only rows of the session's tenant are ever considered.
    const visible = departments
      .filter((d) => d.tenantId === access.tenantId && d.archived === archived)
      .sort(byName);
    const start = cursor ? visible.findIndex((d) => d.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = visible[start + limit];
    return HttpResponse.json<DepartmentPage>({
      items: visible.slice(start, start + limit),
      nextCursor: next?.id ?? null,
      total: visible.length,
    });
  }),

  http.post('*/api/departments', async ({ request }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const fields = await readFields(request, true);
    if (!fields?.name) return invalid();
    if (nameTaken(access.tenantId, fields.name)) return taken();
    const department: Department = {
      id: `dep_new_${++created}`,
      tenantId: access.tenantId,
      name: fields.name,
      ...(fields.description ? { description: fields.description } : {}),
      archived: false,
      version: 1,
    };
    departments.push(department);
    return HttpResponse.json<Department>(department, { status: 201 });
  }),

  http.patch('*/api/departments/:departmentId', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const fields = await readFields(request, false);
    if (!fields || fields.expectedVersion === undefined) return invalid();
    const department = find(access.tenantId, params.departmentId);
    if (!department) return notFound();
    if (department.version !== fields.expectedVersion) {
      return error(409, 'conflict', 'The department has changed');
    }
    if (fields.name && nameTaken(access.tenantId, fields.name, department.id)) return taken();
    const name = fields.name ?? department.name;
    const description = fields.description ?? department.description;
    // Sending what the department already has changes nothing.
    if (name !== department.name || (description ?? '') !== (department.description ?? '')) {
      department.name = name;
      if (description) department.description = description;
      else delete department.description;
      department.version += 1;
    }
    return HttpResponse.json<Department>(department);
  }),

  ...(['archive', 'restore'] as const).map((action) =>
    http.post(`*/api/departments/:departmentId/${action}`, ({ request, params }) => {
      const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
      const department = find(access.tenantId, params.departmentId);
      if (!department) return notFound();
      const archived = action === 'archive';
      // Doing it twice is harmless, so a retried request cannot fail.
      if (department.archived !== archived) {
        department.archived = archived;
        department.version += 1;
      }
      return HttpResponse.json<Department>(department);
    }),
  ),
];
