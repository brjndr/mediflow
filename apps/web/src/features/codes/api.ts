import { api, requireData } from '@/shared/api';
import { codePageSchema, codeSchema } from './schemas';
import type { Code, CodePage, CodeSystem } from './types';

export interface CodeFilters {
  system: CodeSystem;
  /** A code or words of a title. Names a code, never a patient, so it may be a query. */
  q: string;
  favourites: boolean;
}

export async function fetchCodes(
  { system, q, favourites, cursor, limit }: CodeFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<CodePage> {
  const result = await api.GET('/codes', {
    params: { query: { system, q: q || undefined, favourites, cursor, limit } },
    signal,
  });
  return codePageSchema.parse(requireData(result));
}

/** Marks a code as one of the hospital's favourites, or takes the mark away. */
export async function setCodeFavourite(codeId: string, favourite: boolean): Promise<Code> {
  const params = { path: { codeId } };
  const result = favourite
    ? await api.PUT('/codes/{codeId}/favourite', { params })
    : await api.DELETE('/codes/{codeId}/favourite', { params });
  return codeSchema.parse(requireData(result));
}
