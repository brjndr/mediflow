import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { useSession } from '@/app/session';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import {
  isEmptyRichText,
  RichTextEditor,
  RichTextView,
  sanitizeRichText,
  type RichTextDocument,
} from '@/shared/ui/rich-text';
import { useFormatters } from '@/tenancy';
import { useAmendNote, useDiscardNote, useNotes, useSignNote } from '../hooks/use-clinical';
import { useDraftNote, type DraftState } from '../hooks/use-draft-note';
import { REASON_MAX, reasonSchema, type ReasonValues } from '../schemas';
import type { ClinicalNote, Encounter } from '../types';

/** Refusals of signing, discarding and amending a note, by the server's code. */
const REFUSED: Record<string, string> = {
  conflict: 'notes.refused.conflict',
  encounter_not_open: 'notes.refused.notOpen',
  note_signed: 'notes.refused.signed',
  already_amended: 'notes.refused.alreadyAmended',
  note_not_found: 'notes.refused.gone',
};

function useRefusal(error: unknown) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  if (!error) return undefined;
  const code = isApiError(error) ? error.serverCode : undefined;
  const key = code === undefined ? undefined : REFUSED[code];
  return key ? t(key) : tCommon(errorMessageKey(error));
}

/**
 * The encounter's notes, for `clinicalNote:read`: the signed ones, oldest first, with their
 * amendments, and the caller's own drafts, which `clinicalNote:write` writes while the encounter
 * is open. A draft is kept on the server as it is written, never in the browser.
 */
export function NotesPanel({ encounter }: { encounter: Encounter }) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const headingId = useId();
  const canWrite = usePermission('clinicalNote:write');
  const userId = useSession()?.user.id;
  const notes = useNotes(encounter.id);
  const box = useRef<HTMLElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  // New drafts started here, by a key of their own until the server gives them an id.
  const [fresh, setFresh] = useState<{ key: string; id?: string }[]>([]);
  // Drafts signed or discarded here: gone at once, before the list is read again.
  const [finished, setFinished] = useState<Set<string>>(() => new Set());
  const [amending, setAmending] = useState<string | null>(null);
  usePanelFocus(amending, box, status);

  const all = useMemo(() => notes.data?.pages.flatMap((page) => page.items) ?? [], [notes.data]);
  const signed = all.filter((note) => note.status === 'signed');
  const claimed = new Set(fresh.map((entry) => entry.id).filter(Boolean));
  const drafts = all.filter(
    (note) =>
      note.status === 'draft' &&
      note.authorId === userId &&
      !claimed.has(note.id) &&
      !finished.has(note.id),
  );
  const open = encounter.status === 'open';
  const signedAt = new Map(signed.map((note) => [note.id, note.signedAt ?? note.createdAt]));

  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  // What was done is said in the status line, which takes focus when what had it went away.
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const finish = (entry: { key?: string; id?: string }, text: string) => {
    if (entry.id) setFinished((now) => new Set(now).add(entry.id as string));
    if (entry.key) setFresh((now) => now.filter((each) => each.key !== entry.key));
    say(text);
  };

  return (
    <section ref={box} aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('notes.heading')}
      </h2>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden"
      >
        {message.text}
      </p>

      {notes.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : notes.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(notes.error))}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void notes.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : (
        <>
          {signed.length === 0 && drafts.length === 0 && fresh.length === 0 && (
            <p className="text-sm">{t('notes.empty')}</p>
          )}
          {signed.length > 0 && (
            <ol className="flex flex-col gap-3">
              {signed.map((note) => (
                <li key={note.id}>
                  <SignedNote
                    note={note}
                    amendsSignedAt={note.amendsId ? signedAt.get(note.amendsId) : undefined}
                    canAmend={
                      canWrite && encounter.status !== 'cancelled' && note.amendedById === undefined
                    }
                    amending={amending === note.id}
                    onAmend={() => setAmending(note.id)}
                    onCancel={() => setAmending(null)}
                    onAmended={() => {
                      setAmending(null);
                      say(t('notes.amended'));
                    }}
                  />
                </li>
              ))}
            </ol>
          )}
          {notes.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              aria-disabled={notes.isFetchingNextPage || undefined}
              onClick={() => {
                if (!notes.isFetchingNextPage) void notes.fetchNextPage();
              }}
            >
              {notes.isFetchingNextPage ? tCommon('grid.loadingMore') : tCommon('grid.loadMore')}
            </Button>
          )}

          {/* A draft is written only with clinicalNote:write and while the encounter is open;
              otherwise its author reads it as it was saved. */}
          {drafts.map((note) =>
            canWrite && open ? (
              <DraftNote
                key={note.id}
                encounterId={encounter.id}
                note={note}
                onFinished={(id, text) => finish({ id }, text)}
              />
            ) : (
              <ReadOnlyDraft key={note.id} note={note} />
            ),
          )}
          {(canWrite && open ? fresh : []).map((entry) => (
            <DraftNote
              key={entry.key}
              encounterId={encounter.id}
              onCreated={(id) =>
                setFresh((now) =>
                  now.some((each) => each.key === entry.key && each.id !== id)
                    ? now.map((each) => (each.key === entry.key ? { ...each, id } : each))
                    : now,
                )
              }
              onFinished={(id, text) => finish({ key: entry.key, id }, text)}
            />
          ))}

          {canWrite && open && (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => setFresh((now) => [...now, { key: crypto.randomUUID() }])}
            >
              {t('notes.write')}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function SignedNote({
  note,
  amendsSignedAt,
  canAmend,
  amending,
  onAmend,
  onCancel,
  onAmended,
}: {
  note: ClinicalNote;
  amendsSignedAt?: string;
  canAmend: boolean;
  amending: boolean;
  onAmend: () => void;
  onCancel: () => void;
  onAmended: () => void;
}) {
  const { t } = useTranslation('clinical');
  const format = useFormatters();
  const superseded = note.amendedById !== undefined;
  return (
    <article
      aria-label={t('notes.signedLabel', {
        name: note.authorName,
        time: format.dateTime(note.signedAt ?? note.createdAt),
      })}
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <p className="text-sm text-muted-foreground">
        {t('notes.signedBy', {
          name: note.authorName,
          time: format.dateTime(note.signedAt ?? note.createdAt),
        })}
      </p>
      {note.amendsId && (
        <p className="text-sm">
          {amendsSignedAt
            ? t('notes.amends', {
                time: format.dateTime(amendsSignedAt),
                reason: note.amendmentReason,
              })
            : t('notes.amendsEarlier', { reason: note.amendmentReason })}
        </p>
      )}
      {superseded && <p className="text-sm font-medium">{t('notes.superseded')}</p>}
      <RichTextView
        document={note.body}
        className={superseded ? 'text-muted-foreground' : undefined}
      />
      {canAmend && !amending && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={onAmend}>
          {t('notes.amend')}
        </Button>
      )}
      {amending && <AmendForm note={note} onCancel={onCancel} onAmended={onAmended} />}
    </article>
  );
}

/** A correction of a signed note: the whole text again, corrected, and why. */
function AmendForm({
  note,
  onCancel,
  onAmended,
}: {
  note: ClinicalNote;
  onCancel: () => void;
  onAmended: () => void;
}) {
  const { t } = useTranslation('clinical');
  const editorError = useId();
  const amend = useAmendNote(note.encounterId);
  const body = useRef<RichTextDocument>(sanitizeRichText(note.body));
  const [empty, setEmpty] = useState(false);
  const form = useZodForm(reasonSchema, { reason: '' });
  const failure = useRefusal(amend.error);

  const submit = (values: ReasonValues) => {
    if (isEmptyRichText(body.current)) {
      setEmpty(true);
      return;
    }
    amend.mutate(
      { noteId: note.id, body: body.current, reason: values.reason },
      { onSuccess: onAmended },
    );
  };

  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      <h3 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('notes.amendHeading')}
      </h3>
      <RichTextEditor
        label={t('notes.amendText')}
        initialValue={note.body}
        invalid={empty}
        describedBy={empty ? editorError : undefined}
        onChange={(document) => {
          body.current = document;
          if (empty && !isEmptyRichText(document)) setEmpty(false);
        }}
      />
      {empty && (
        <p id={editorError} role="alert" className="text-sm text-destructive">
          {t('notes.emptyRefused')}
        </p>
      )}
      <Form form={form} onSubmit={submit}>
        <TextField<ReasonValues>
          name="reason"
          label={t('notes.amendReason')}
          required
          maxLength={REASON_MAX}
          autoComplete="off"
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={amend.isPending}>
            {amend.isPending ? t('notes.amending') : t('notes.amendSubmit')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('cancel')}
          </Button>
        </div>
      </Form>
    </div>
  );
}

function saveLine(state: DraftState, t: TFunction<'clinical'>, time: (at: string) => string) {
  switch (state.kind) {
    case 'saving':
      return t('notes.draft.saving');
    case 'saved':
      return t('notes.draft.saved', { time: time(state.at) });
    case 'empty':
      return t('notes.draft.empty');
    case 'idle':
      return t('notes.draft.unsaved');
    default:
      return '';
  }
}

/** A draft of the caller's they may no longer write: shown as it was saved, to read. */
function ReadOnlyDraft({ note }: { note: ClinicalNote }) {
  const { t } = useTranslation('clinical');
  return (
    <article
      aria-label={t('notes.draft.heading')}
      className="flex flex-col gap-2 rounded-md border border-dashed p-3"
    >
      <p className="text-sm font-medium">{t('notes.draft.readOnly')}</p>
      <RichTextView document={note.body} />
    </article>
  );
}

/**
 * One draft of the caller's: written in the editor and kept on the server as it is written
 * (`useDraftNote`), then signed or discarded. The line under the editor says whether what is
 * shown is saved; it is plain text, not a live region, as it changes at every pause in typing.
 * A failed save and a conflict are alerts. While it is signed or discarded the editor takes no
 * typing (`inert`), so nothing typed then is lost or sent to a signed note.
 */
function DraftNote({
  encounterId,
  note,
  onCreated,
  onFinished,
}: {
  encounterId: string;
  note?: ClinicalNote;
  onCreated?: (id: string) => void;
  onFinished: (id: string | undefined, message: string) => void;
}) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const headingId = useId();
  const lineId = useId();
  const draft = useDraftNote(encounterId, note, { onCreated });
  const sign = useSignNote(encounterId);
  const discard = useDiscardNote(encounterId);
  const [editor, setEditor] = useState<{ key: number; initial: unknown }>({
    key: 0,
    initial: note?.body,
  });
  const [confirming, setConfirming] = useState(false);
  const [finishing, setFinishing] = useState<'sign' | 'discard' | null>(null);
  const actions = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const editorBox = useRef<HTMLDivElement>(null);
  const state = draft.state;
  const busy = finishing !== null || sign.isPending || discard.isPending;

  // A new draft is written at once: the heading takes focus, Tab goes on to the editor.
  useEffect(() => {
    if (!note) heading.current?.focus();
  }, [note]);

  useEffect(() => {
    if (editorBox.current) editorBox.current.inert = busy;
  }, [busy]);

  // A block that held focus went away (a conflict answered, a retry): back to the draft.
  const backToDraft = () => requestAnimationFrame(() => focusIfLost(heading.current));

  const signNow = async () => {
    if (busy) return;
    setFinishing('sign');
    sign.reset();
    discard.reset();
    const done = await draft.flush();
    const saved = done ? await draft.stop() : undefined;
    if (!saved) {
      draft.resume();
      setFinishing(null);
      return;
    }
    sign.mutate(
      { noteId: saved.id, version: saved.version },
      {
        onSuccess: () => onFinished(saved.id, t('notes.signed')),
        onError: (error) => {
          draft.resume();
          // Saved from another window meanwhile: the same choice as a save that met it.
          if (isApiError(error) && error.serverCode === 'conflict') draft.conflicted();
        },
        onSettled: () => setFinishing(null),
      },
    );
  };

  const discardNow = async () => {
    if (busy) return;
    setFinishing('discard');
    sign.reset();
    discard.reset();
    // Whatever is being saved settles first, so a draft it creates is the one removed.
    const saved = await draft.stop();
    if (!saved) {
      // Never reached the server: nothing to remove there.
      onFinished(undefined, t('notes.discarded'));
      return;
    }
    discard.mutate(saved.id, {
      onSuccess: () => onFinished(saved.id, t('notes.discarded')),
      onError: () => draft.resume(),
      onSettled: () => setFinishing(null),
    });
  };

  const failure = useRefusal(sign.error ?? discard.error);

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-md border border-dashed p-3"
    >
      <h3
        ref={heading}
        id={headingId}
        tabIndex={-1}
        className="font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {t('notes.draft.heading')}
      </h3>
      <div
        ref={editorBox}
        onBlur={(event) => {
          // Leaving the editor (not moving within its toolbar) saves at once.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            void draft.flush();
          }
        }}
      >
        <RichTextEditor
          key={editor.key}
          label={t('notes.draft.label')}
          describedBy={lineId}
          initialValue={editor.initial}
          onChange={draft.change}
        />
      </div>
      <p id={lineId} className="text-sm text-muted-foreground empty:hidden">
        {saveLine(state, t, (at) => format.time(at))}
      </p>
      {state.kind === 'conflict' && (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{t('notes.draft.conflict')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                sign.reset();
                void draft.resolve('mine').then(backToDraft);
              }}
            >
              {t('notes.draft.keepMine')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                sign.reset();
                void draft.resolve('saved').then((document) => {
                  if (document) setEditor((now) => ({ key: now.key + 1, initial: document }));
                  backToDraft();
                });
              }}
            >
              {t('notes.draft.takeSaved')}
            </Button>
          </div>
        </div>
      )}
      {state.kind === 'failed' && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {t('notes.draft.failed', { reason: tCommon(errorMessageKey(state.error)) })}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void draft.flush().then(backToDraft)}
          >
            {tCommon('grid.retry')}
          </Button>
        </div>
      )}
      {failure && state.kind !== 'conflict' && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      <div ref={actions}>
        {confirming ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm">{t('notes.draft.confirmDiscard')}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="destructive"
                aria-disabled={busy || undefined}
                onClick={() => void discardNow()}
              >
                {finishing === 'discard'
                  ? t('notes.draft.discarding')
                  : t('notes.draft.discardConfirmed')}
              </Button>
              <Button
                data-action="keep"
                type="button"
                variant="outline"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (busy) return;
                  setConfirming(false);
                  // Back to the button that asked.
                  requestAnimationFrame(() =>
                    actions.current?.querySelector<HTMLElement>('[data-action="discard"]')?.focus(),
                  );
                }}
              >
                {t('notes.draft.keep')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              aria-disabled={busy || undefined}
              aria-busy={finishing === 'sign' || undefined}
              onClick={() => void signNow()}
            >
              {finishing === 'sign' ? t('notes.draft.signing') : t('notes.draft.sign')}
            </Button>
            <Button
              data-action="discard"
              type="button"
              variant="outline"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return;
                setConfirming(true);
                // The question takes the button's place: focus goes to its safe answer.
                requestAnimationFrame(() =>
                  actions.current?.querySelector<HTMLElement>('[data-action="keep"]')?.focus(),
                );
              }}
            >
              {t('notes.draft.discard')}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
