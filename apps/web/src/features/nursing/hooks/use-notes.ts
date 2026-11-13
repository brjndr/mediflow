import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useTenant } from '@/tenancy';
import { createNote, fetchNoteHistory, fetchNotes, updateNote } from '../api';
import type { ProgressNote, ProgressNoteCreate } from '../types';
import { nursingKeys, REFRESH_MS } from './use-nursing';

export const NOTES_PAGE_SIZE = 50;

const notesKey = (tenantId: string, admissionId: string) =>
  [...nursingKeys.all(tenantId), 'notes', admissionId] as const;

/** The stay's notes, newest first, a page at a time. */
export function useNotes(admissionId: string) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: [...notesKey(tenantId ?? '', admissionId), { limit: NOTES_PAGE_SIZE }],
    queryFn: ({ pageParam, signal }) =>
      fetchNotes({ admissionId, cursor: pageParam, limit: NOTES_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
  });
}

/** Every text one note had; read only while its history is open. */
export function useNoteHistory(noteId: string) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: [...nursingKeys.all(tenantId ?? ''), 'note-history', noteId],
    queryFn: ({ pageParam, signal }) =>
      fetchNoteHistory({ noteId, cursor: pageParam, limit: NOTES_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
  });
}

/** One key per request body, so a double click or a retry adds the note once. */
export function useAddNote(admissionId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    gcTime: 0,
    mutationFn: (body: ProgressNoteCreate) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return createNote(admissionId, body, attempt.current.key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: () => {
      if (tenantId) {
        return queryClient.invalidateQueries({ queryKey: notesKey(tenantId, admissionId) });
      }
    },
  });
}

/** Amends a note from the version the edit started from; a stale version answers 409. */
export function useAmendNote(admissionId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return useMutation({
    gcTime: 0,
    mutationFn: ({ note, body }: { note: ProgressNote; body: string }) =>
      updateNote(note.id, { body, version: note.version }),
    onSettled: () => {
      if (tenantId) {
        void queryClient.invalidateQueries({
          queryKey: [...nursingKeys.all(tenantId), 'note-history'],
        });
        return queryClient.invalidateQueries({ queryKey: notesKey(tenantId, admissionId) });
      }
    },
  });
}
