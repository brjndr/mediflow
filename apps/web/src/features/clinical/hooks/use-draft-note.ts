import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '@/shared/api';
import { isEmptyRichText, sanitizeRichText, type RichTextDocument } from '@/shared/ui/rich-text';
import { createNote, fetchNote, saveNote } from '../api';
import type { ClinicalNote } from '../types';
import { useIdempotencyKey, useStillHere } from './use-clinical';

/** How long typing has to stop before the draft is saved. Leaving the editor saves at once. */
export const AUTOSAVE_MS = 1500;

export type DraftState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: string }
  /** Nothing to save yet: an empty note is never sent. */
  | { kind: 'empty' }
  /** Saved from elsewhere (another window) since this one read it: saving waits for a choice. */
  | { kind: 'conflict' }
  | { kind: 'failed'; error: unknown };

const serialize = (document: RichTextDocument) => JSON.stringify(document);

/**
 * A draft note kept on the server as it is written: created on the first save, then saved whole
 * from the version it was read at, after a pause in typing, when the editor loses focus, before
 * signing and when the editor goes away. What is typed lives in memory only until then, never in
 * browser storage. One save at a time; a change made meanwhile is saved after it.
 *
 * Nothing is sent once the session has ended or moved to another hospital.
 */
export function useDraftNote(encounterId: string, start?: ClinicalNote) {
  const stillHere = useStillHere();
  const keys = useIdempotencyKey();
  const noteId = useRef(start?.id);
  const version = useRef(start?.version ?? 0);
  const [initial] = useState(() => {
    const body = sanitizeRichText(start?.body);
    return { body, serialized: serialize(body) };
  });
  const current = useRef<RichTextDocument>(initial.body);
  const saved = useRef(initial.serialized);
  // The save to run again after a pause; set once `saveNow` exists, which schedules it itself.
  const again = useRef<() => void>(() => undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const running = useRef<Promise<boolean> | null>(null);
  const paused = useRef(false);
  const [state, setState] = useState<DraftState>(
    start ? { kind: 'saved', at: start.updatedAt } : { kind: 'idle' },
  );

  const dirty = () => serialize(current.current) !== saved.current;

  const saveNow = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current);
    // Wait for the save in flight; whatever was typed meanwhile is saved after it.
    while (running.current) await running.current;
    if (paused.current || !stillHere()) return false;
    if (!dirty()) return noteId.current !== undefined;
    const body = current.current;
    if (isEmptyRichText(body)) {
      setState({ kind: 'empty' });
      return false;
    }
    setState({ kind: 'saving' });
    const run = (async () => {
      try {
        const id = noteId.current;
        const note =
          id === undefined
            ? await createNote(encounterId, body, keys.keyFor({ encounterId, body }))
            : await saveNote(id, body, version.current);
        if (id === undefined) keys.clear();
        noteId.current = note.id;
        version.current = note.version;
        saved.current = serialize(body);
        setState(dirty() ? { kind: 'idle' } : { kind: 'saved', at: note.updatedAt });
        return true;
      } catch (error) {
        if (isApiError(error) && error.serverCode === 'conflict') {
          paused.current = true;
          setState({ kind: 'conflict' });
        } else {
          setState({ kind: 'failed', error });
        }
        return false;
      } finally {
        running.current = null;
      }
    })();
    running.current = run;
    const done = await run;
    if (done && dirty()) timer.current = setTimeout(() => again.current(), AUTOSAVE_MS);
    return done;
  }, [encounterId, keys, stillHere]);

  useEffect(() => {
    again.current = () => void saveNow();
  }, [saveNow]);

  const change = useCallback(
    (document: RichTextDocument) => {
      current.current = document;
      if (paused.current) return;
      clearTimeout(timer.current);
      if (dirty()) {
        setState((now) => (now.kind === 'saving' ? now : { kind: 'idle' }));
        timer.current = setTimeout(() => void saveNow(), AUTOSAVE_MS);
      }
    },
    [saveNow],
  );

  /**
   * After a conflict: read the draft as saved elsewhere, then either save what is typed here over
   * it (`mine`) or take what was saved (`saved`), whose document is returned for the editor.
   */
  const resolve = useCallback(
    async (choice: 'mine' | 'saved'): Promise<RichTextDocument | undefined> => {
      const id = noteId.current;
      if (id === undefined || !stillHere()) return undefined;
      let latest: ClinicalNote;
      try {
        latest = await fetchNote(id);
      } catch (error) {
        setState({ kind: 'failed', error });
        return undefined;
      }
      version.current = latest.version;
      paused.current = false;
      if (choice === 'saved') {
        current.current = sanitizeRichText(latest.body);
        saved.current = serialize(current.current);
        setState({ kind: 'saved', at: latest.updatedAt });
        return current.current;
      }
      saved.current = serialize(sanitizeRichText(latest.body));
      await saveNow();
      return undefined;
    },
    [saveNow, stillHere],
  );

  // What was typed and not yet saved is saved when the editor goes away (leaving the screen).
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (!paused.current && serialize(current.current) !== saved.current) void saveNow();
    },
    [saveNow],
  );

  return {
    state,
    change,
    /** Saves now what is not saved yet. True once the server holds the draft as it reads here. */
    flush: saveNow,
    resolve,
    /** The draft's id and version on the server, once it has been created. */
    saved: () =>
      noteId.current === undefined ? undefined : { id: noteId.current, version: version.current },
    isEmpty: () => isEmptyRichText(current.current),
  };
}
