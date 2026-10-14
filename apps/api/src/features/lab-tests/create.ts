import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { tidyOptional, tidyWithin } from '../../core/http/text.js';
import { RowProblem, type ImportKind, type Writer } from '../../core/imports/registry.js';
import {
  codeTaken,
  insertLabTest,
  isCodeTaken,
  isLabService,
  labServiceByCode,
  lockUsableComponents,
  replaceComponents,
  type LabTestDetails,
} from './repository.js';
import {
  CONTAINER_MAX,
  LAB_DEPARTMENTS,
  LabTestCreate,
  NAME_MAX,
  RESULT_TYPES,
  SAMPLE_TYPES,
  UNIT_MAX,
} from './schemas.js';

export const taken = () =>
  new HttpError(409, 'lab_test_code_taken', 'The hospital has a test with that code');
export const invalid = (message: string) => new HttpError(400, 'validation_failed', message);

/** A name as it is stored, and not empty once it is tidied. */
export function cleanName(name: string): string {
  const tidied = tidyWithin(name, NAME_MAX);
  if (tidied === '') throw invalid('A name is required');
  return tidied;
}

/** The service a test is charged as: a laboratory service of this hospital that is in use. */
export async function serviceFor(writer: Writer, sent: string): Promise<string | null> {
  if (sent === '') return null;
  if (!(await isLabService(writer.txClient, sent))) {
    throw invalid('serviceId is not a laboratory service of this hospital that is in use');
  }
  return sent.toLowerCase();
}

/** The components a request names for a panel, checked and locked. */
export async function componentsFor(writer: Writer, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) throw invalid('A panel has at least one component');
  if (new Set(ids).size !== ids.length) throw invalid('A component is named twice');
  if (!(await lockUsableComponents(writer.txClient, ids))) {
    throw invalid('Every component is a single test of this hospital that is in use');
  }
}

export interface NewLabTest {
  code: string;
  kind: LabTestCreate['kind'];
  details: LabTestDetails;
  componentIds: string[];
}

/**
 * What a new test or panel will be, refused when its code is taken or what it names is not of
 * this hospital. Reads only, except that a panel's components are locked until the end.
 */
export async function prepareLabTest(writer: Writer, body: LabTestCreate): Promise<NewLabTest> {
  const panel = body.kind === 'panel';
  const componentIds = body.componentIds ?? [];
  const details: LabTestDetails = {
    name: cleanName(body.name),
    department: body.department,
    // A panel has no result of its own, whatever was sent.
    resultType: panel ? 'text' : (body.resultType ?? 'text'),
    unit: panel ? null : tidyOptional(body.unit, UNIT_MAX),
    sampleType: body.sampleType,
    container: tidyOptional(body.container, CONTAINER_MAX),
    turnaroundHours: body.turnaroundHours,
    serviceId: body.serviceId === undefined ? null : await serviceFor(writer, body.serviceId),
  };
  if (panel) await componentsFor(writer, componentIds);
  else if (componentIds.length > 0) throw invalid('A single test has no components');
  if (await codeTaken(writer.txClient, body.code)) throw taken();
  return { code: body.code, kind: body.kind, details, componentIds };
}

/** Adds the test or panel, audited and announced. */
export async function writeLabTest(writer: Writer, test: NewLabTest): Promise<string> {
  let id: string;
  try {
    id = await insertLabTest(writer.txClient, {
      ...test.details,
      code: test.code,
      kind: test.kind,
    });
  } catch (error) {
    // Two requests for the same new code at once: the database lets one through.
    if (isCodeTaken(error)) throw taken();
    throw error;
  }
  if (test.kind === 'panel') await replaceComponents(writer.txClient, id, test.componentIds);
  writer.audit('create', 'lab_test', id);
  await writer.emit('master.changed', id, { kind: 'lab_test', change: 'created' });
  return id;
}

/**
 * A row of a file of tests: a single test, charged as the service of the code given. A panel and
 * reference ranges are made on the catalog screen, which can show what they are made of.
 */
const LabTestImportRow = Type.Object(
  {
    ...Type.Omit(LabTestCreate, ['kind', 'serviceId', 'componentIds']).properties,
    serviceCode: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
  },
  { additionalProperties: false },
);

/** Single tests loaded from a file by the import centre, as `POST /lab-tests` adds them. */
export const labTestImport: ImportKind<NewLabTest> = {
  kind: 'lab_tests',
  feature: 'lab_tests',
  permissions: ['labTest:manage'],
  body: LabTestImportRow,
  columns: [
    { field: 'code', required: true, type: 'text' },
    { field: 'name', required: true, type: 'text' },
    { field: 'department', required: true, type: 'enum', values: LAB_DEPARTMENTS },
    { field: 'resultType', required: false, type: 'enum', values: RESULT_TYPES },
    { field: 'unit', required: false, type: 'text' },
    { field: 'sampleType', required: true, type: 'enum', values: SAMPLE_TYPES },
    { field: 'container', required: false, type: 'text' },
    { field: 'turnaroundHours', required: true, type: 'integer' },
    { field: 'serviceCode', required: false, type: 'text' },
  ],
  async prepare(writer, row) {
    const { serviceCode, ...rest } = row as Omit<LabTestCreate, 'kind'> & { serviceCode?: string };
    let serviceId: string | undefined;
    if (serviceCode !== undefined) {
      const id = await labServiceByCode(writer.txClient, serviceCode);
      if (!id) throw new RowProblem('serviceCode', 'not_found');
      serviceId = id;
    }
    const test = await prepareLabTest(writer, {
      ...rest,
      kind: 'test',
      ...(serviceId === undefined ? {} : { serviceId }),
    });
    // A code is one test whatever its capitals.
    return { value: test, key: test.code.toLowerCase() };
  },
  write: async (writer, test) => {
    await writeLabTest(writer, test);
  },
};
