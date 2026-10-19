import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useTenant } from '@/tenancy';
import { changeQueue, issueToken, type QueueAction } from '../api';
import type { QueueTokenCreate } from '../types';
import { queueKeys } from './use-queue';

/**
 * A key per request body: an identical resubmit (a double click, a retry) reuses it and is done
 * once, while another body gets a new key.
 */
function useIdempotencyKey() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return {
    keyFor(body: unknown) {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return attempt.current.key;
    },
    /** After an answer: the next request is a new one, even with the same body. */
    clear() {
      attempt.current = undefined;
    },
  };
}

/** Issues a token. Whatever the answer, the queue has changed and is read again. */
export function useIssueToken() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const keys = useIdempotencyKey();
  return useMutation({
    // Nothing about the patient stays in the mutation cache once the form is gone.
    gcTime: 0,
    mutationFn: (body: QueueTokenCreate) => issueToken(body, keys.keyFor(body)),
    onSuccess: () => keys.clear(),
    onSettled: () => {
      if (tenantId) return queryClient.invalidateQueries({ queryKey: queueKeys.all(tenantId) });
    },
  });
}

/**
 * Calls, skips, recalls and sets a priority. Not shown before the server answers: the order of
 * the queue is the server's, and another desk may have called the same patient first.
 */
export function useQueueAction() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (action: QueueAction) => changeQueue(action, keys.keyFor(action)),
    onSuccess: () => keys.clear(),
    onSettled: () => {
      if (tenantId) return queryClient.invalidateQueries({ queryKey: queueKeys.all(tenantId) });
    },
  });
}
