import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import type { SlotProps } from '@/registry';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { useDocumentLink, usePatientDocuments } from '../hooks/use-documents';
import type { PatientDocument } from '../types';
import { UploadForm } from './UploadForm';

/**
 * The documents of one visit (`encounter.detail.actions`, #562), for `document:read`: a
 * "Documents" button that opens, under the actions, the files attached to this visit. Nothing is
 * read until it is opened. `document:upload` adds a file to the patient's record linked to the
 * visit (the API checks the visit is the patient's). Given ids and the status only.
 */
export default function EncounterDocuments({ context }: SlotProps) {
  const { t } = useTranslation('documents');
  const canRead = usePermission('document:read');
  const { encounterId, patientId, status } = context ?? {};
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!canRead || typeof encounterId !== 'string' || typeof patientId !== 'string') return null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((now) => !now)}
      >
        {t('encounter.action')}
      </Button>
      {open && (
        <VisitDocuments
          id={panelId}
          // Keyed by the visit: another visit's documents are never carried over.
          key={encounterId}
          encounterId={encounterId}
          patientId={patientId}
          cancelled={status === 'cancelled'}
        />
      )}
    </>
  );
}

function VisitDocuments({
  id,
  encounterId,
  patientId,
  cancelled,
}: {
  id: string;
  encounterId: string;
  patientId: string;
  cancelled: boolean;
}) {
  const { t } = useTranslation('documents');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const canUpload = usePermission('document:upload');
  const documents = usePatientDocuments(patientId, {
    category: '',
    includeRetired: false,
    encounterId,
  });
  const link = useDocumentLink();
  const rows = useMemo(
    () => documents.data?.pages.flatMap((page) => page.items) ?? [],
    [documents.data],
  );
  const status = useRef<HTMLParagraphElement>(null);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const columns = useMemo<GridColumn<PatientDocument>[]>(
    () => [
      {
        id: 'title',
        header: t('columns.title'),
        value: (row) => row.title,
        hideable: false,
        render: (row, text) => (
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{text}</span>
            <span className="text-sm text-muted-foreground">{row.fileName}</span>
          </span>
        ),
      },
      {
        id: 'category',
        header: t('columns.category'),
        value: (row) => t(`category.${row.category}`),
      },
      { id: 'added', header: t('columns.added'), value: (row) => format.dateTime(row.createdAt) },
      { id: 'state', header: t('columns.state'), value: (row) => t(`status.${row.status}`) },
    ],
    [t, format],
  );

  const actions: GridAction<PatientDocument>[] = [
    {
      id: 'open',
      label: t('open.action'),
      requires: 'document:read',
      disabled: (row) => row.status !== 'clean' || link.isPending,
      onSelect: (row) => {
        if (row.status !== 'clean' || link.isPending) return;
        link.mutate(row.id, {
          onSuccess: (url) => {
            window.open(url, '_blank', 'noopener,noreferrer');
            say(t('open.done', { title: row.title }));
          },
          onError: (error) => say(tCommon(errorMessageKey(error))),
        });
      },
    },
  ];

  return (
    <section id={id} aria-label={t('encounter.heading')} className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{t('encounter.heading')}</h3>
        {canUpload && !cancelled && !adding && (
          <Button type="button" onClick={() => setAdding(true)}>
            {t('upload.action')}
          </Button>
        )}
      </div>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm outline-none empty:hidden focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {message.text && <span key={message.count}>{message.text}</span>}
      </p>
      {adding && (
        <UploadForm
          patientId={patientId}
          encounterId={encounterId}
          onClose={() => setAdding(false)}
          onUploaded={(document) => {
            setAdding(false);
            say(t('upload.done', { title: document.title }));
          }}
        />
      )}
      <DataGrid
        label={t('encounter.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('rowLabel', { title: row.title })}
        actions={actions}
        status={documents.isPending ? 'loading' : documents.isError ? 'error' : 'ready'}
        errorMessage={documents.isError ? tCommon(errorMessageKey(documents.error)) : undefined}
        onRetry={() => void documents.refetch()}
        emptyMessage={t('encounter.empty')}
        hasNextPage={documents.hasNextPage}
        loadingMore={documents.isFetchingNextPage}
        onLoadMore={() => void documents.fetchNextPage()}
      />
    </section>
  );
}
