import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { i18n as I18n } from 'i18next';
import { useTranslation } from 'react-i18next';
import { printInstance } from '@/shared/lib/print-language';
import { useStillHere } from './use-clinical';

/**
 * A print (#89): `prepare` reads what the page needs and records the print on the server, with a
 * new idempotency key per press; the page is shown (`job`) only once both succeeded, and only
 * for the session it was asked in. `done` drops it when the print dialog closes. Leaving the
 * screen aborts what is still being read. `print('hi')` prints in another language (#771): the
 * job then carries the `i18n` to draw the sheet with, its `namespaces` loaded first.
 */
export function usePrinting<Job>(
  prepare: (idempotencyKey: string, signal: AbortSignal) => Promise<Job>,
  namespaces: readonly string[] = [],
) {
  const { i18n } = useTranslation();
  const stillHere = useStillHere();
  const abort = useRef<AbortController>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
  const [job, setJob] = useState<{ id: number; value: Job; i18n?: I18n } | null>(null);
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: async (language: string | undefined) => {
      abort.current = new AbortController();
      const sheetI18n = language ? await printInstance(i18n, language, namespaces) : undefined;
      const value = await prepare(crypto.randomUUID(), abort.current.signal);
      return { value, sheetI18n };
    },
    onSuccess: ({ value, sheetI18n }) => {
      if (stillHere() && !abort.current?.signal.aborted)
        setJob((now) => ({ id: (now?.id ?? 0) + 1, value, i18n: sheetI18n }));
    },
  });
  const { isPending, mutate } = mutation;
  const print = useCallback(
    (language?: string) => {
      if (!isPending) mutate(language);
    },
    [isPending, mutate],
  );
  const done = useCallback(() => setJob(null), []);
  return { print, busy: isPending, error: mutation.error, job, done };
}
