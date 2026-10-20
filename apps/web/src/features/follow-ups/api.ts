import { api, requireData } from '@/shared/api';
import { followUpPageSchema, followUpSchema } from './schemas';
import type { FollowUp, FollowUpBook, FollowUpCreate, FollowUpPage, FollowUpState } from './types';

// Every address holds ids, days and a state only: nothing about the patient is in a URL. Every
// POST carries an idempotency key, which the API requires.

export interface DueListFilters {
  state: FollowUpState | '';
  dueFrom: string;
  dueTo: string;
  doctorId: string;
}

/** The hospital's follow-ups the caller may see, the soonest due first. */
export async function fetchFollowUps(
  {
    state,
    dueFrom,
    dueTo,
    doctorId,
    cursor,
    limit,
  }: DueListFilters & {
    cursor?: string;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<FollowUpPage> {
  const result = await api.GET('/follow-ups', {
    params: {
      query: {
        state: state || undefined,
        dueFrom: dueFrom || undefined,
        dueTo: dueTo || undefined,
        doctorId: doctorId || undefined,
        cursor,
        limit,
      },
    },
    signal,
  });
  return followUpPageSchema.parse(requireData(result));
}

/** The encounter's follow-ups, cancelled ones included: at most one that is not. */
export async function fetchEncounterFollowUps(
  { encounterId, cursor, limit }: { encounterId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<FollowUpPage> {
  const result = await api.GET('/encounters/{encounterId}/follow-ups', {
    params: { path: { encounterId }, query: { cursor, limit } },
    signal,
  });
  return followUpPageSchema.parse(requireData(result));
}

export async function createFollowUp(
  encounterId: string,
  body: FollowUpCreate,
  idempotencyKey: string,
): Promise<FollowUp> {
  const result = await api.POST('/encounters/{encounterId}/follow-ups', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return followUpSchema.parse(requireData(result));
}

export async function bookFollowUp(
  followUpId: string,
  body: FollowUpBook,
  idempotencyKey: string,
): Promise<FollowUp> {
  const result = await api.POST('/follow-ups/{followUpId}/book', {
    params: { path: { followUpId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return followUpSchema.parse(requireData(result));
}

export async function cancelFollowUp(
  followUpId: string,
  body: { reason: string; version: number },
  idempotencyKey: string,
): Promise<FollowUp> {
  const result = await api.POST('/follow-ups/{followUpId}/cancel', {
    params: { path: { followUpId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return followUpSchema.parse(requireData(result));
}
