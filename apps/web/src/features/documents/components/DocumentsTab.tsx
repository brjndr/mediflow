import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { DetailTab } from '@/features/patients';
import type { SlotProps } from '@/registry';
import { errorMessageKey } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { useDocumentLink, usePatientDocuments } from '../hooks/use-documents';
import { DOCUMENT_CATEGORIES } from '../schemas';
import type { DocumentCategory, PatientDocument } from '../types';
import { HoldForm } from './HoldForm';
import { RetireForm } from './RetireForm';
import { UploadForm } from './UploadForm';

/**
 * The "Documents" tab of the patient's screen (`patient.detail.tabs`, #189), for `document:read`:
 * scanned reports and outside records kept on the record, newest first, a page at a time,
 * filtered by category on the server. Opening one asks the API for a signed, short-lived link
 * (audited there as an export); a file still being scanned or blocked cannot be opened.
 * `document:upload` attaches a file and `document:retire` retires one with a reason. Given the
 * patient's id only, and reads nothing until the tab is opened.
 */
export default function DocumentsTab({ context }: SlotProps) {
  const { t } = useTranslation('documents');
  const canRead = usePermission('document:read');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  if (!patientId || !canRead) return null;
  return (
    <DetailTab id="documents" title={t('tab')}>
      {/* Keyed by the patient: another patient's documents are never carried over. */}
      <PatientDocuments key={patientId} patientId={patientId} />
    </DetailTab>
  );
}

type Panel =
  | { kind: 'upload' }
  | { kind: 'hold-patient' }
  | { kind: 'retire' | 'hold'; document: PatientDocument }
  | null;

function PatientDocuments({ patientId }: { patientId: string }) {
  const { t } = useTranslation('documents');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const headingId = useId();
  const categoryId = useId();
  const canUpload = usePermission('document:upload');
  const canHold = usePermission('documentRetention:manage');
  const [category, setCategory] = useState<DocumentCategory | ''>('');
  const [includeRetired, setIncludeRetired] = useState(false);
  const documents = usePatientDocuments(patientId, { category, includeRetired });
  const link = useDocumentLink();
  const rows = useMemo(
    () => documents.data?.pages.flatMap((page) => page.items) ?? [],
    [documents.data],
  );
  // A file seen waiting for its scan that comes back blocked is told to the uploader.
  const waiting = useRef(new Set<string>());
  const box = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  usePanelFocus(
    panel ? `${panel.kind}:${'document' in panel ? panel.document.id : ''}` : null,
    box,
    status,
  );
  useEffect(() => {
    for (const row of rows) {
      if (row.status === 'pending' || row.status === 'scanning') {
        waiting.current.add(row.id);
      } else if (
        waiting.current.delete(row.id) &&
        (row.status === 'infected' || row.status === 'failed')
      ) {
        say(t(`blocked.${row.status}`, { title: row.title }));
      }
    }
  }, [rows, t]);
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const sizeWords = (bytes: number) =>
    bytes >= 1024 * 1024
      ? t('size.mb', { value: format.number(Math.round((bytes / (1024 * 1024)) * 10) / 10) })
      : t('size.kb', { value: format.number(Math.max(1, Math.round(bytes / 1024))) });

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
      {
        id: 'added',
        header: t('columns.added'),
        value: (row) => format.dateTime(row.createdAt),
      },
      {
        id: 'size',
        header: t('columns.size'),
        value: (row) => sizeWords(row.size),
      },
      {
        id: 'state',
        header: t('columns.state'),
        value: (row) =>
          row.retiredAt
            ? t('state.retired', { reason: row.retiredReason ?? '' })
            : t(`status.${row.status}`),
        render: (row, text) => (
          <span className="flex flex-wrap items-center gap-1.5">
            <span>{text}</span>
            {row.held && (
              <span className="rounded-md border border-amber-600 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                {t('state.held')}
              </span>
            )}
          </span>
        ),
      },
      {
        id: 'keptUntil',
        header: t('columns.keptUntil'),
        value: (row) => (row.retainUntil ? format.calendarDate(row.retainUntil) : t('keptForEver')),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sizeWords closes over t and format.
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
    {
      id: 'retire',
      label: t('retire.action'),
      requires: 'document:retire',
      disabled: (row) => row.retiredAt !== undefined,
      onSelect: (row) => {
        if (row.retiredAt === undefined) setPanel({ kind: 'retire', document: row });
      },
    },
    {
      id: 'hold',
      label: t('hold.action'),
      requires: 'documentRetention:manage',
      onSelect: (row) => setPanel({ kind: 'hold', document: row }),
    },
  ];

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-lg font-semibold">
          {t('heading')}
        </h2>
        <div className="flex flex-wrap gap-2">
          {canHold && panel?.kind !== 'hold-patient' && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setPanel({ kind: 'hold-patient' })}
            >
              {t('hold.actionPatient')}
            </Button>
          )}
          {canUpload && panel?.kind !== 'upload' && (
            <Button type="button" onClick={() => setPanel({ kind: 'upload' })}>
              {t('upload.action')}
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={categoryId} className="text-sm font-medium">
            {t('filter.category')}
          </label>
          <select
            id={categoryId}
            value={category}
            onChange={(event) => setCategory(event.target.value as DocumentCategory | '')}
            className="h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11"
          >
            <option value="">{t('filter.all')}</option>
            {DOCUMENT_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {t(`category.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm pointer-coarse:min-h-11">
          <input
            type="checkbox"
            checked={includeRetired}
            onChange={(event) => setIncludeRetired(event.target.checked)}
            className="size-4"
          />
          {t('filter.retired')}
        </label>
      </div>
      <div ref={box} className="flex flex-col gap-3">
        {/* Always on the page, so what was done is read when it is said. */}
        <p
          ref={status}
          tabIndex={-1}
          role="status"
          className="text-sm outline-none empty:hidden focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {message.text && <span key={message.count}>{message.text}</span>}
        </p>
        {panel?.kind === 'upload' && (
          <UploadForm
            patientId={patientId}
            onClose={() => setPanel(null)}
            onUploaded={(document) => {
              setPanel(null);
              say(t('upload.done', { title: document.title }));
            }}
          />
        )}
        {panel?.kind === 'retire' && (
          <RetireForm
            document={panel.document}
            onClose={() => setPanel(null)}
            onRetired={(document) => {
              setPanel(null);
              say(t('retire.done', { title: document.title }));
            }}
          />
        )}
        {canHold && (panel?.kind === 'hold' || panel?.kind === 'hold-patient') && (
          <HoldForm
            patientId={patientId}
            document={panel.kind === 'hold' ? panel.document : undefined}
            onClose={() => setPanel(null)}
            onPlaced={(hold) => {
              setPanel(null);
              say(t(hold.documentId ? 'hold.done' : 'hold.donePatient'));
            }}
          />
        )}
        <DataGrid
          label={t('heading')}
          columns={columns}
          rows={rows}
          rowId={(row) => row.id}
          rowLabel={(row) => t('rowLabel', { title: row.title })}
          actions={actions}
          status={documents.isPending ? 'loading' : documents.isError ? 'error' : 'ready'}
          errorMessage={documents.isError ? tCommon(errorMessageKey(documents.error)) : undefined}
          onRetry={() => void documents.refetch()}
          emptyMessage={t('empty')}
          hasNextPage={documents.hasNextPage}
          loadingMore={documents.isFetchingNextPage}
          onLoadMore={() => void documents.fetchNextPage()}
        />
      </div>
    </section>
  );
}
