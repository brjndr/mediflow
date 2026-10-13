import { api, requireData } from '@/shared/api';
import {
  labRangeResolvedSchema,
  labRangesSchema,
  labTestPageSchema,
  labTestSchema,
  serviceOptionsSchema,
  type ServiceOption,
} from './schemas';
import type { AgeUnit } from './age';
import type {
  LabDepartment,
  LabRange,
  LabRanges,
  LabTest,
  LabTestCreate,
  LabTestKind,
  LabTestPage,
  LabTestUpdate,
  PatientSex,
} from './types';

export interface LabTestFilters {
  /** A code or a name of a test. Sent in the body of the search, never in an address. */
  q: string;
  department: LabDepartment | '';
  kind: LabTestKind | '';
  archived: boolean;
}

export async function fetchLabTests(
  {
    cursor,
    limit,
    q,
    department,
    kind,
    archived,
  }: LabTestFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<LabTestPage> {
  // The term is sent in the body, never in an address: see Searches in CLAUDE.md.
  const result = await api.POST('/lab-tests/search', {
    body: {
      cursor,
      limit,
      q: q || undefined,
      department: department || undefined,
      kind: kind || undefined,
      archived,
    },
    signal,
  });
  return labTestPageSchema.parse(requireData(result));
}

export async function fetchLabTest(labTestId: string, signal?: AbortSignal): Promise<LabTest> {
  const result = await api.GET('/lab-tests/{labTestId}', {
    params: { path: { labTestId } },
    signal,
  });
  return labTestSchema.parse(requireData(result));
}

/**
 * Adds a test. The key makes a repeat of the same request (a double click, a retry after a lost
 * answer) add one test, not fail on its own code.
 */
export async function createLabTest(body: LabTestCreate, idempotencyKey: string): Promise<LabTest> {
  const result = await api.POST('/lab-tests', {
    body,
    params: { header: { 'idempotency-key': idempotencyKey } },
  });
  return labTestSchema.parse(requireData(result));
}

export async function updateLabTest(labTestId: string, body: LabTestUpdate): Promise<LabTest> {
  const result = await api.PATCH('/lab-tests/{labTestId}', {
    params: { path: { labTestId } },
    body,
  });
  return labTestSchema.parse(requireData(result));
}

export async function setLabTestArchived(labTestId: string, archived: boolean): Promise<LabTest> {
  const params = { path: { labTestId } };
  const result = archived
    ? await api.POST('/lab-tests/{labTestId}/archive', { params })
    : await api.POST('/lab-tests/{labTestId}/restore', { params });
  return labTestSchema.parse(requireData(result));
}

export async function fetchLabRanges(labTestId: string, signal?: AbortSignal): Promise<LabRanges> {
  const result = await api.GET('/lab-tests/{labTestId}/ranges', {
    params: { path: { labTestId } },
    signal,
  });
  return labRangesSchema.parse(requireData(result));
}

export async function saveLabRanges(
  labTestId: string,
  body: { ranges: LabRange[]; expectedVersion: number },
): Promise<LabRanges> {
  const result = await api.PUT('/lab-tests/{labTestId}/ranges', {
    params: { path: { labTestId } },
    body,
  });
  return labRangesSchema.parse(requireData(result));
}

/** The range the server would use for a patient of this age and sex, if any. */
export async function resolveLabRange(
  labTestId: string,
  query: { ageValue: number; ageUnit: AgeUnit; sex: PatientSex },
  signal?: AbortSignal,
): Promise<LabRange | null> {
  const result = await api.GET('/lab-tests/{labTestId}/ranges/resolve', {
    params: { path: { labTestId }, query },
    signal,
  });
  return labRangeResolvedSchema.parse(requireData(result)).range ?? null;
}

/**
 * The laboratory services of the price catalog a test can be charged as, by a word of the code
 * or name. The services module's endpoint; only the id, code and name are read.
 */
export async function fetchLabServices(
  q: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ items: ServiceOption[]; more: boolean }> {
  const result = await api.POST('/services/search', {
    body: { limit, q: q || undefined, category: 'lab', archived: false },
    signal,
  });
  const page = serviceOptionsSchema.parse(requireData(result));
  return { items: page.items, more: page.nextCursor !== null };
}
