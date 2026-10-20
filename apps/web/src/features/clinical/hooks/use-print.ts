import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStillHere } from './use-clinical';

/**
 * A print (#89): `prepare` reads what the page needs and records the print on the server, with a
 * new idempotency key per press; the page is shown (`job`) only once both succeeded, and only
 * for the session it was asked in. `done` drops it when the print dialog closes. Leaving the
 * screen aborts what is still being read.
 */
export function usePrinting<Job>(
  prepare: (idempotencyKey: string, signal: AbortSignal) => Promise<Job>,
) {
  const stillHere = useStillHere();
  const abort = useRef<AbortController>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
  const [job, setJob] = useState<{ id: number; value: Job } | null>(null);
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: () => {
      abort.current = new AbortController();
      return prepare(crypto.randomUUID(), abort.current.signal);
    },
    onSuccess: (value) => {
      if (stillHere() && !abort.current?.signal.aborted)
        setJob((now) => ({ id: (now?.id ?? 0) + 1, value }));
    },
  });
  const { isPending, mutate } = mutation;
  const print = useCallback(() => {
    if (!isPending) mutate();
  }, [isPending, mutate]);
  const done = useCallback(() => setJob(null), []);
  return { print, busy: isPending, error: mutation.error, job, done };
}
