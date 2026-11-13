import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, TextAreaField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useAmendNote, useNoteHistory } from '../hooks/use-notes';
import { noteEditSchema, type NoteEditValues } from '../notes-schemas';
import type { ProgressNote } from '../types';

const REFUSED: Record<string, string> = {
  conflict: 'notes.refused.conflict',
  not_author: 'notes.refused.notAuthor',
  admission_not_open: 'notes.refused.notOpen',
};

/**
 * Amends a note (#159). Nothing is overwritten: the server keeps each text as a numbered version,
 * and the edit names the version it started from, so two people never replace each other's text
 * without knowing (409 `conflict`).
 */
export function EditNoteDialog({
  note,
  admissionId,
  onClose,
  onSaved,
}: {
  note: ProgressNote;
  admissionId: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { t } = useTranslation('nursing');
  const { t: tCommon } = useTranslation();
  const amend = useAmendNote(admissionId);
  const form = useZodForm(noteEditSchema, { body: note.body });
  const FORM_ID = 'note-edit-form';

  const failure = (): string | undefined => {
    if (!amend.error) return undefined;
    if (isApiError(amend.error) && amend.error.serverCode) {
      const key = REFUSED[amend.error.serverCode];
      if (key) return t(key);
    }
    return tCommon(errorMessageKey(amend.error));
  };

  const submit = async (values: NoteEditValues) => {
    try {
      await amend.mutateAsync({ note, body: values.body });
      onSaved(t('notes.done.amended'));
    } catch {
      // Said below, from the mutation state.
    }
  };

  const message = failure();
  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('notes.editTitle')}
      description={t('notes.editLine', { version: note.version })}
      closeLabel={t('notes.close')}
      busy={amend.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('form.cancel')}
          </Button>
          <Button type="submit" form={FORM_ID} aria-disabled={amend.isPending || undefined}>
            {t('notes.saveAmendment')}
          </Button>
        </>
      }
    >
      <Form form={form} id={FORM_ID} onSubmit={(values) => void submit(values)}>
        <TextAreaField<NoteEditValues> name="body" label={t('notes.body')} rows={6} required />
        {message && (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        )}
      </Form>
    </Dialog>
  );
}

/** Every text a note had, newest first, with who wrote it and when. */
export function NoteHistoryDialog({ note, onClose }: { note: ProgressNote; onClose: () => void }) {
  const { t } = useTranslation('nursing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const history = useNoteHistory(note.id);
  const versions = history.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('notes.historyTitle')}
      description={t('notes.historyLine', { count: note.version })}
      closeLabel={t('notes.close')}
      footer={<Button onClick={onClose}>{t('notes.close')}</Button>}
    >
      {history.isPending && <p role="status">{tCommon('grid.loading')}</p>}
      {history.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(history.error))}
        </p>
      )}
      <ol className="flex flex-col gap-3">
        {versions.map((each) => (
          <li key={each.version} className="rounded-md border p-3">
            <p className="text-sm font-medium">
              {t('notes.versionLine', {
                version: each.version,
                by: each.editedByName,
                time: format.dateTime(each.editedAt),
              })}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{each.body}</p>
          </li>
        ))}
      </ol>
      {history.hasNextPage && (
        <Button
          variant="outline"
          aria-disabled={history.isFetchingNextPage || undefined}
          onClick={() => void history.fetchNextPage()}
        >
          {t('notes.loadMore')}
        </Button>
      )}
    </Dialog>
  );
}
