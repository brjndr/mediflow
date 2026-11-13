import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Can } from '@/access';
import { useSession } from '@/app/session';
import { EncounterOrders } from '@/features/clinical';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SelectField, SubmitButton, TextAreaField, useZodForm } from '@/shared/ui/form';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { EditNoteDialog, NoteHistoryDialog } from '../components/NoteDialogs';
import { useAddNote, useNotes } from '../hooks/use-notes';
import { useStay } from '../hooks/use-nursing';
import { NOTE_KINDS, NOTE_MAX, noteFormSchema, type NoteValues } from '../notes-schemas';
import type { ProgressNote } from '../types';

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function Notes() {
  const { t } = useTranslation('nursing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const session = useSession();
  const { admissionId = '' } = useParams();
  const stay = useStay(admissionId);
  const notes = useNotes(admissionId);
  const add = useAddNote(admissionId);
  const form = useZodForm(noteFormSchema, { kind: 'observation', body: '' });
  const [editing, setEditing] = useState<ProgressNote>();
  const [history, setHistory] = useState<ProgressNote>();
  const [done, setDone] = useState('');
  const statusLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (done) focusIfLost(statusLine.current);
  }, [done]);

  const rows = useMemo(() => notes.data?.pages.flatMap((page) => page.items) ?? [], [notes.data]);
  const open = stay.data?.status === 'admitted';

  const refusal = (error: unknown): string => {
    if (isApiError(error) && error.serverCode === 'admission_not_open') {
      return t('notes.refused.notOpen');
    }
    return tCommon(errorMessageKey(error));
  };

  const submit = async (values: NoteValues) => {
    setDone('');
    try {
      await add.mutateAsync(values);
      form.reset({ kind: values.kind, body: '' });
      setDone(t('notes.done.added'));
    } catch {
      focusIfLost(statusLine.current);
    }
  };

  const columns = useMemo<GridColumn<ProgressNote>[]>(
    () => [
      {
        id: 'time',
        header: t('columns.written'),
        value: (row) => format.dateTime(row.createdAt),
        hideable: false,
      },
      { id: 'kind', header: t('notes.kind'), value: (row) => t(`notes.kinds.${row.kind}`) },
      { id: 'author', header: t('columns.by'), value: (row) => row.createdByName },
      { id: 'body', header: t('notes.body'), value: (row) => row.body },
      {
        id: 'version',
        header: t('notes.versionHeader'),
        value: (row) =>
          row.version > 1
            ? t('notes.amendedAt', { version: row.version, time: format.dateTime(row.updatedAt) })
            : t('notes.original'),
      },
    ],
    [t, format],
  );

  const actions: GridAction<ProgressNote>[] = [
    {
      id: 'edit',
      label: t('notes.edit'),
      requires: 'progressNote:write',
      // Only the author edits a note, and only while the patient is admitted.
      disabled: (row) => !open || row.createdById !== session?.user.id,
      onSelect: (row) => setEditing(row),
    },
    { id: 'history', label: t('notes.history'), onSelect: (row) => setHistory(row) },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        <Link to="/nursing/rounds" className="text-sm underline underline-offset-2">
          {t('notes.back')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {stay.data ? t('notes.heading', { patient: stay.data.patientName }) : t('notes.loading')}
        </h1>
        {stay.data && (
          <p className="text-muted-foreground">
            {t('stayLine', {
              mrn: maskMrn(stay.data.patientMrn),
              bed: stay.data.bed?.bedNumber ?? t('noBed'),
              ward: stay.data.bed?.wardName ?? '',
            })}
          </p>
        )}
      </div>

      {stay.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(stay.error))}
        </p>
      )}
      {stay.data && !open && <p className="text-sm font-medium">{t('notes.closed')}</p>}

      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done}
      </p>

      <Can permission="progressNote:write">
        {open && (
          <section
            aria-labelledby="note-heading"
            className="flex flex-col gap-3 rounded-md border p-4"
          >
            <h2 id="note-heading" className="text-lg font-semibold">
              {t('notes.addHeading')}
            </h2>
            <Form form={form} onSubmit={(values: NoteValues) => void submit(values)}>
              <SelectField<NoteValues>
                name="kind"
                label={t('notes.kind')}
                options={NOTE_KINDS.map((value) => ({
                  value,
                  label: t(`notes.kinds.${value}`),
                }))}
              />
              <TextAreaField<NoteValues>
                name="body"
                label={t('notes.body')}
                rows={5}
                maxLength={NOTE_MAX}
                required
              />
              {add.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {refusal(add.error)}
                </p>
              )}
              <div>
                <SubmitButton pending={add.isPending}>{t('notes.add')}</SubmitButton>
              </div>
            </Form>
          </section>
        )}
      </Can>

      <DataGrid
        label={t('notes.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('notes.rowLabel', { time: format.dateTime(row.createdAt) })}
        actions={actions}
        status={notes.isPending ? 'loading' : notes.isError ? 'error' : 'ready'}
        errorMessage={notes.isError ? tCommon(errorMessageKey(notes.error)) : undefined}
        onRetry={() => void notes.refetch()}
        emptyMessage={t('notes.empty')}
        hasNextPage={notes.hasNextPage}
        loadingMore={notes.isFetchingNextPage}
        onLoadMore={() => void notes.fetchNextPage()}
      />

      {stay.data && open && (
        <section aria-labelledby="orders-heading" className="flex flex-col gap-3">
          <h2 id="orders-heading" className="text-lg font-semibold">
            {t('notes.ordersHeading')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('notes.ordersHint')}</p>
          <EncounterOrders encounterId={stay.data.encounterId} />
        </section>
      )}

      {editing && (
        <EditNoteDialog
          note={editing}
          admissionId={admissionId}
          onClose={() => setEditing(undefined)}
          onSaved={(message) => {
            setEditing(undefined);
            setDone(message);
          }}
        />
      )}
      {history && <NoteHistoryDialog note={history} onClose={() => setHistory(undefined)} />}
    </div>
  );
}
