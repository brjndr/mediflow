import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Form, SelectField, SubmitButton, TextAreaField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useAddNote, useNotes } from '../hooks/use-emergency';
import { NOTE_KINDS, NOTE_MAX, noteFormSchema, type NoteFormValues } from '../schemas';
import type { EmergencyCase } from '../types';
import { failureText } from './failure';

/**
 * Observation notes and assessments of a case, oldest first. Never edited: a correction is a new
 * note. Written for `emergency:care`, also for a patient not yet identified.
 */
export function NotesPanel({ row }: { row: EmergencyCase }) {
  const { t } = useTranslation('emergency');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const headingId = useId();
  const canWrite = usePermission('emergency:care');
  const open = row.status !== 'disposed';
  const notes = useNotes(row.id, canWrite);
  const add = useAddNote();
  const [message, setMessage] = useState('');
  const form = useZodForm(noteFormSchema, { kind: 'observation', body: '' });
  if (!canWrite) return null;
  const items = notes.data?.pages.flatMap((page) => page.items) ?? [];
  const failure = failureText(add.error, t, tCommon);

  const submit = async (values: NoteFormValues) => {
    try {
      await add.mutateAsync({ caseId: row.id, kind: values.kind, body: values.body });
      form.reset({ kind: values.kind, body: '' });
      setMessage(t('notes.added'));
      form.setFocus('body');
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('notes.heading')}
      </h2>
      <p role="status" className="text-sm font-medium empty:sr-only">
        {message}
      </p>
      {notes.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(notes.error))}
        </p>
      ) : notes.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('notes.empty')}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {items.map((note) => (
            <li key={note.id} className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">
                {t(`notes.kind.${note.kind}`)} · {note.authorName} ·{' '}
                {format.dateTime(note.createdAt)}
              </p>
              <p className="whitespace-pre-wrap break-words">{note.body}</p>
            </li>
          ))}
        </ol>
      )}
      {notes.hasNextPage && (
        <Button
          variant="outline"
          className="self-start"
          onClick={() => void notes.fetchNextPage()}
          aria-busy={notes.isFetchingNextPage}
        >
          {t('notes.more')}
        </Button>
      )}
      {open && (
        <Form form={form} onSubmit={submit}>
          <SelectField<NoteFormValues>
            name="kind"
            label={t('notes.type')}
            options={NOTE_KINDS.map((value) => ({ value, label: t(`notes.kind.${value}`) }))}
          />
          <TextAreaField<NoteFormValues>
            name="body"
            label={t('notes.body')}
            required
            maxLength={NOTE_MAX}
          />
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          <SubmitButton className="self-start" pending={add.isPending}>
            {t('notes.add')}
          </SubmitButton>
        </Form>
      )}
    </section>
  );
}
