import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '@/shared/api';
import { isEmptyRichText, sanitizeRichText, type RichTextDocument } from '@/shared/ui/rich-text';
import { createNote, fetchNote, saveNote } from '../api';
import type { ClinicalNote } from '../types';
import { useStillHere } from './use-clinical';

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

/** A refusal the server decided: the request did nothing, so it is not sent again as it was. */
const refused = (error: unknown) =>
  isApiError(error) && error.status !== undefined && error.status >= 400 && error.status < 500;

/**
 * A draft note kept on the server as it is written: created on the first save, then saved whole
 * from the version it was read at, after a pause in typing, when the editor loses focus, before
 * signing and when the editor goes away. What is typed lives in memory only until then, never in
 * browser storage. One save at a time; a change made meanwhile is saved after it.
 *
 * A first save whose answer never came may have created the draft: it is sent again with the same
 * body and key before anything newer, so the server answers with that draft instead of making a
 * second one. Once the draft is signed or discarded (`stop`), nothing more is sent. Nothing is
 * sent once the session has ended or moved to another hospital either.
 */
export function useDraftNote(
  encounterId: string,
  start?: ClinicalNote,
  { onCreated }: { onCreated?: (id: string) => void } = {},
) {
  const stillHere = useStillHere();
  const [initial] = useState(() => {
    const body = sanitizeRichText(start?.body);
    return { body, serialized: serialize(body) };
  });
  const noteId = useRef(start?.id);
  const version = useRef(start?.version ?? 0);
  const current = useRef<RichTextDocument>(initial.body);
  const saved = useRef(initial.serialized);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const running = useRef<Promise<boolean> | null>(null);
  const paused = useRef(false);
  const stopped = useRef(false);
  // A create sent whose outcome is not known: its body and key, to send again as they were.
  const unsettled = useRef<{ body: RichTextDocument; key: string }>(undefined);
  const created = useRef(onCreated);
  useEffect(() => {
    created.current = onCreated;
  }, [onCreated]);
  // The save to run after a pause; set once `saveNow` exists, which schedules it itself.
  const again = useRef<() => void>(() => undefined);
  const [state, setState] = useState<DraftState>(
    start ? { kind: 'saved', at: start.updatedAt } : { kind: 'empty' },
  );

  const dirty = () => serialize(current.current) !== saved.current;
  const settle = async () => {
    while (running.current) await running.current;
  };

  /** One request: the create (or its repeat), or a save of what is shown. */
  const saveOnce = useCallback(async (): Promise<boolean> => {
    const id = noteId.current;
    const body = current.current;
    setState({ kind: 'saving' });
    const run = (async () => {
      try {
        if (id === undefined) {
          const attempt = unsettled.current ?? { body, key: crypto.randomUUID() };
          unsettled.current = attempt;
          const note = await createNote(encounterId, attempt.body, attempt.key);
          unsettled.current = undefined;
          noteId.current = note.id;
          version.current = note.version;
          saved.current = serialize(attempt.body);
          created.current?.(note.id);
          setState(dirty() ? { kind: 'idle' } : { kind: 'saved', at: note.updatedAt });
        } else {
          const note = await saveNote(id, body, version.current);
          version.current = note.version;
          saved.current = serialize(body);
          setState(dirty() ? { kind: 'idle' } : { kind: 'saved', at: note.updatedAt });
        }
        return true;
      } catch (error) {
        if (id === undefined && refused(error)) unsettled.current = undefined;
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
    return run;
  }, [encounterId]);

  /**
   * Saves what is not saved yet, after the save in flight. With `untilClean` it goes on until the
   * server holds what is shown (before signing); otherwise newer typing waits for its own pause.
   * True once the server holds the draft as it reads here.
   */
  const saveNow = useCallback(
    async (untilClean = false): Promise<boolean> => {
      clearTimeout(timer.current);
      await settle();
      for (;;) {
        if (stopped.current || paused.current || !stillHere()) return false;
        if (isEmptyRichText(current.current)) {
          setState({ kind: 'empty' });
          return false;
        }
        if (!dirty() && unsettled.current === undefined) return noteId.current !== undefined;
        const done = await saveOnce();
        if (!done) return false;
        if (!dirty()) return true;
        if (!untilClean) {
          timer.current = setTimeout(() => again.current(), AUTOSAVE_MS);
          return true;
        }
      }
    },
    [saveOnce, stillHere],
  );

  useEffect(() => {
    again.current = () => void saveNow();
  }, [saveNow]);

  const change = useCallback((document: RichTextDocument) => {
    current.current = document;
    if (paused.current || stopped.current) return;
    clearTimeout(timer.current);
    if (isEmptyRichText(document)) {
      setState((now) => (now.kind === 'saving' ? now : { kind: 'empty' }));
    } else if (dirty()) {
      setState((now) => (now.kind === 'saving' ? now : { kind: 'idle' }));
      timer.current = setTimeout(() => again.current(), AUTOSAVE_MS);
    }
  }, []);

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
      const theirs = sanitizeRichText(latest.body);
      saved.current = serialize(theirs);
      if (choice === 'saved') current.current = theirs;
      if (choice === 'saved' || !dirty()) {
        setState({ kind: 'saved', at: latest.updatedAt });
      } else {
        await saveNow(true);
      }
      return choice === 'saved' ? theirs : undefined;
    },
    [saveNow, stillHere],
  );

  /** The server refused signing at the version held: it was saved elsewhere meanwhile. */
  const conflicted = useCallback(() => {
    clearTimeout(timer.current);
    paused.current = true;
    setState({ kind: 'conflict' });
  }, []);

  /**
   * Nothing more is sent: the draft is being signed or discarded. Waits for a save in flight and
   * gives the draft's id on the server, if it has one by then. `resume` undoes it after a refusal.
   */
  const stop = useCallback(async () => {
    stopped.current = true;
    clearTimeout(timer.current);
    await settle();
    return noteId.current === undefined
      ? undefined
      : { id: noteId.current, version: version.current };
  }, []);
  const resume = useCallback(() => {
    stopped.current = false;
    if (dirty()) timer.current = setTimeout(() => again.current(), AUTOSAVE_MS);
  }, []);

  // What was typed and not yet saved is saved when the editor goes away (leaving the screen),
  // unless the draft was signed or discarded.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (!stopped.current && !paused.current && serialize(current.current) !== saved.current) {
        void saveNow();
      }
    },
    [saveNow],
  );

  return { state, change, flush: () => saveNow(true), resolve, conflicted, stop, resume };
}
