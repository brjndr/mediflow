import { z } from 'zod';
import { apiFetch } from '@/shared/api';
import { env } from '@/shared/config/env';

/**
 * Example data for the grid page. This endpoint exists only in the mock backend, so it is not in
 * the API contract and is called through `apiFetch` with its own schema. A real feature uses the
 * typed `api` client instead.
 */
const personSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  department: z.enum(['cardiology', 'neurology', 'orthopaedics', 'paediatrics']),
  phone: z.string(),
  mrn: z.string(),
  balanceMinor: z.number().int(),
});
const pageSchema = z.object({
  items: z.array(personSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export type ExamplePerson = z.infer<typeof personSchema>;
export type ExamplePeoplePage = z.infer<typeof pageSchema>;
export type PeopleSort = { id: 'name' | 'mrn'; desc: boolean } | null;

export const EXAMPLE_PAGE_SIZE = 50;

export async function fetchExamplePeople(
  { cursor, sort }: { cursor?: string; sort: PeopleSort },
  signal?: AbortSignal,
): Promise<ExamplePeoplePage> {
  const url = new URL(`${env.apiBaseUrl}/examples/people`, window.location.origin);
  url.searchParams.set('limit', String(EXAMPLE_PAGE_SIZE));
  if (cursor) url.searchParams.set('cursor', cursor);
  // Sorting is the server's job: the grid only says which sort it wants.
  if (sort) url.searchParams.set('sort', `${sort.desc ? '-' : ''}${sort.id}`);
  const response = await apiFetch(url, { signal });
  return pageSchema.parse(await response.json());
}
