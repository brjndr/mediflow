import { api, requireData } from '@/shared/api';
import { queueTokenPageSchema, queueTokenSchema } from './schemas';
import type {
  QueuePriority,
  QueueToken,
  QueueTokenCreate,
  QueueTokenPage,
  QueueTokenStatus,
} from './types';

export interface QueueFilters {
  /** Empty: every department. Ids only: nothing about a patient. */
  departmentId: string;
  /** A doctor's queue: theirs and their department's unassigned tokens. Empty: no doctor. */
  doctorId: string;
  status: QueueTokenStatus;
}

/** Today's tokens at the hospital in call order. The server decides what today is. */
export async function fetchQueueTokens(
  {
    departmentId,
    doctorId,
    status,
    cursor,
    limit,
  }: QueueFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<QueueTokenPage> {
  const result = await api.GET('/queue/tokens', {
    params: {
      query: {
        departmentId: departmentId || undefined,
        doctorId: doctorId || undefined,
        status,
        cursor,
        limit,
      },
    },
    signal,
  });
  return queueTokenPageSchema.parse(requireData(result));
}

/**
 * Issues a token. The number is the server's; the idempotency key makes a retry or a double
 * click return the first token, not a second one.
 */
export async function issueToken(
  body: QueueTokenCreate,
  idempotencyKey: string,
): Promise<QueueToken> {
  const result = await api.POST('/queue/tokens', {
    body,
    params: { header: { 'idempotency-key': idempotencyKey } },
  });
  return queueTokenSchema.parse(requireData(result));
}

/** A change of the queue, each with the token's version except calling the next one. */
export type QueueAction =
  | { kind: 'call_next'; doctorId: string }
  | { kind: 'call_again' | 'skip' | 'recall'; tokenId: string; version: number }
  | { kind: 'priority'; tokenId: string; version: number; priority: QueuePriority | null };

export async function changeQueue(
  action: QueueAction,
  idempotencyKey: string,
): Promise<QueueToken> {
  const header = { 'idempotency-key': idempotencyKey };
  let result;
  switch (action.kind) {
    case 'call_next':
      result = await api.POST('/queue/call-next', {
        params: { header },
        body: { doctorId: action.doctorId },
      });
      break;
    case 'call_again':
      result = await api.POST('/queue/tokens/{tokenId}/call-again', {
        params: { header, path: { tokenId: action.tokenId } },
        body: { version: action.version },
      });
      break;
    case 'skip':
      result = await api.POST('/queue/tokens/{tokenId}/skip', {
        params: { header, path: { tokenId: action.tokenId } },
        body: { version: action.version },
      });
      break;
    case 'recall':
      result = await api.POST('/queue/tokens/{tokenId}/recall', {
        params: { header, path: { tokenId: action.tokenId } },
        body: { version: action.version },
      });
      break;
    case 'priority':
      result = await api.POST('/queue/tokens/{tokenId}/priority', {
        params: { header, path: { tokenId: action.tokenId } },
        body: { version: action.version, priority: action.priority },
      });
      break;
  }
  return queueTokenSchema.parse(requireData(result));
}

/**
 * Opens the hospital's queue event stream through the API client (session cookie, tenant header,
 * error handling). Its events say which department's queue changed, never who.
 */
export async function openQueueEvents(signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const result = await api.GET('/queue/events', { parseAs: 'stream', signal });
  if (!result.data) throw new TypeError('Expected an event stream');
  return result.data;
}
