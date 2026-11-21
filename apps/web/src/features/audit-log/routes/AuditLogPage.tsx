import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Can, usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { todayIn } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import type { AuditFilters } from '../api';
import {
  useAuditSearch,
  useExportLink,
  useExportList,
  useExportRun,
  useRequestExport,
} from '../hooks/use-audit-log';
import { downloadFile, useStaffNames } from '../lib/bridge';
import { useRecordLink } from '../lib/record-link';
import { filterSchema, shiftDay, WORKING, type FilterValues } from '../schemas';
import type { AuditEntry, ReportRun } from '../types';

const KNOWN_ERRORS = ['range_too_long', 'report_quota', 'report_busy'] as const;

/** Filters as the API takes them: empty text is no filter. */
const toFilters = (values: FilterValues): AuditFilters => ({
  from: values.from,
  to: values.to,
  ...(values.actorId ? { actorId: values.actorId } : {}),
  ...(values.entity.trim() ? { entity: values.entity.trim() } : {}),
  ...(values.entityId.trim() ? { entityId: values.entityId.trim() } : {}),
  ...(values.action.trim() ? { action: values.action.trim() } : {}),
  ...(values.q.trim() ? { q: values.q.trim() } : {}),
});

/**
 * The hospital's audit log (#1066): who did what to which record, newest first, for a range of
 * days, with an export of the range as a CSV. Entries name record ids, never a patient.
 */
export default function AuditLogPage() {
  const { t } = useTranslation('audit_log');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const today = todayIn(timezone);
  const staff = useStaffNames();
  const recordLink = useRecordLink();

  const initial: FilterValues = {
    from: shiftDay(today, -6),
    to: today,
    actorId: '',
    entity: '',
    entityId: '',
    action: '',
    q: '',
  };
  const form = useZodForm(filterSchema, initial);
  const [applied, setApplied] = useState<AuditFilters>(() => toFilters(initial));
  const query = useAuditSearch(applied);

  const request = useRequestExport();
  const link = useExportLink();
  const [runId, setRunId] = useState<string | null>(null);
  const run = useExportRun(runId);
  const mayList = usePermission('report:read');
  const exportList = useExportList(mayList);
  const exportRows = useMemo(
    () => exportList.data?.pages.flatMap((page) => page.items) ?? [],
    [exportList.data],
  );
  const exportColumns = useMemo<GridColumn<ReportRun>[]>(
    () => [
      {
        id: 'period',
        header: t('exports.columns.period'),
        value: (row) =>
          row.from && row.to
            ? t('exports.period', {
                from: format.calendarDate(row.from),
                to: format.calendarDate(row.to),
              })
            : '',
        hideable: false,
      },
      {
        id: 'filters',
        header: t('exports.columns.filters'),
        value: (row) => {
          const f = row.filters;
          const parts = [
            f?.actorId ? t('exports.filters.actor', { value: f.actorName ?? f.actorId }) : '',
            f?.entity ? t('exports.filters.entity', { value: f.entity }) : '',
            f?.entityId ? t('exports.filters.entityId', { value: f.entityId }) : '',
            f?.action ? t('exports.filters.action', { value: f.action }) : '',
            f?.q ? t('exports.filters.q', { value: f.q }) : '',
          ].filter(Boolean);
          return parts.length > 0 ? parts.join('; ') : t('exports.unfiltered');
        },
      },
      {
        id: 'requested',
        header: t('exports.columns.requested'),
        value: (row) => format.dateTime(row.requestedAt),
      },
      { id: 'by', header: t('exports.columns.by'), value: (row) => row.requestedBy.name },
      {
        id: 'status',
        header: t('exports.columns.status'),
        value: (row) => t(`exports.status.${row.status}`),
      },
    ],
    [t, format],
  );

  const askedFor = (error: unknown): string => {
    if (isApiError(error) && error.serverCode !== undefined) {
      const known = KNOWN_ERRORS.find((code) => code === error.serverCode);
      if (known) return t(`export.errors.${known}`);
    }
    return tCommon(errorMessageKey(error));
  };

  const ended = run.data?.status;
  const statusText = request.isError
    ? askedFor(request.error)
    : link.isError
      ? askedFor(link.error)
      : ended === 'succeeded'
        ? t('export.ready')
        : ended === 'failed'
          ? t('export.failed')
          : runId !== null
            ? t('export.working')
            : '';
  const working = request.isPending || (ended !== undefined && WORKING.includes(ended));

  const columns = useMemo<GridColumn<AuditEntry>[]>(
    () => [
      {
        id: 'at',
        header: t('columns.at'),
        value: (row) => format.dateTime(row.at),
        hideable: false,
      },
      {
        id: 'actor',
        header: t('columns.actor'),
        value: (row) => (row.actor ? row.actor.name || row.actor.id : t('system')),
      },
      { id: 'action', header: t('columns.action'), value: (row) => row.action },
      { id: 'entity', header: t('columns.entity'), value: (row) => row.entity },
      {
        id: 'entityId',
        header: t('columns.entityId'),
        value: (row) => row.entityId ?? '',
        render: (row, text) => {
          const to = recordLink(row.entity, row.entityId);
          return to ? (
            <Link to={to} className="underline underline-offset-2">
              {text}
            </Link>
          ) : (
            text
          );
        },
      },
      { id: 'detail', header: t('columns.detail'), value: (row) => row.detail ?? '' },
    ],
    [t, format, recordLink],
  );
  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <Form
        form={form}
        onSubmit={(values) => {
          setApplied(toFilters(values));
          return Promise.resolve();
        }}
        className="max-w-3xl"
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField<FilterValues> name="from" type="date" label={t('form.from')} required />
          <TextField<FilterValues> name="to" type="date" label={t('form.to')} required />
        </div>
        {staff.available && (
          <SelectField<FilterValues>
            name="actorId"
            label={t('form.actor')}
            placeholder={t('form.anyone')}
            options={(staff.data ?? []).map((person) => ({ value: person.id, label: person.name }))}
          />
        )}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <TextField<FilterValues>
            name="entity"
            label={t('form.entity')}
            hint={t('form.entityHint')}
          />
          <TextField<FilterValues> name="entityId" label={t('form.entityId')} />
          <TextField<FilterValues>
            name="action"
            label={t('form.action')}
            hint={t('form.actionHint')}
          />
        </div>
        <TextField<FilterValues>
          name="q"
          label={t('form.q')}
          hint={t('form.qHint')}
          inputMode="search"
        />
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={query.isFetching}>{t('form.search')}</SubmitButton>
        </div>
      </Form>
      <div className="flex flex-wrap items-center gap-2">
        <Can permission="auditLog:export">
          <Button
            type="button"
            variant="outline"
            aria-disabled={working}
            onClick={() => {
              link.reset();
              setRunId(null);
              request.mutate(applied, { onSuccess: (made) => setRunId(made.id) });
            }}
          >
            {t('export.button')}
          </Button>
          {ended === 'succeeded' && runId !== null && (
            <Button
              type="button"
              aria-disabled={link.isPending}
              onClick={() => link.mutate(runId, { onSuccess: (made) => downloadFile(made.url) })}
            >
              {t('export.download')}
            </Button>
          )}
        </Can>
        <p role="status" className="text-sm text-muted-foreground">
          {statusText}
        </p>
      </div>
      <section aria-labelledby="audit-entries" className="flex flex-col gap-2">
        <h2 id="audit-entries" className="text-lg font-semibold">
          {t('entries.heading')}
        </h2>
        <DataGrid
          label={t('entries.heading')}
          columns={columns}
          rows={rows}
          rowId={(row) => row.id}
          rowLabel={(row) => `${row.entity} ${row.action}`}
          status={query.isPending ? 'loading' : query.isError ? 'error' : 'ready'}
          errorMessage={query.isError ? askedFor(query.error) : undefined}
          onRetry={() => void query.refetch()}
          emptyMessage={t('entries.empty')}
          hasNextPage={query.hasNextPage && !query.isPlaceholderData}
          loadingMore={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
        />
      </section>
      {mayList && (
        <section aria-labelledby="audit-exports" className="flex flex-col gap-2">
          <h2 id="audit-exports" className="text-lg font-semibold">
            {t('exports.heading')}
          </h2>
          <DataGrid
            label={t('exports.heading')}
            columns={exportColumns}
            rows={exportRows}
            rowId={(row) => row.id}
            rowLabel={(row) => format.dateTime(row.requestedAt)}
            status={exportList.isPending ? 'loading' : exportList.isError ? 'error' : 'ready'}
            errorMessage={exportList.isError ? askedFor(exportList.error) : undefined}
            onRetry={() => void exportList.refetch()}
            emptyMessage={t('exports.empty')}
            hasNextPage={exportList.hasNextPage}
            loadingMore={exportList.isFetchingNextPage}
            onLoadMore={() => void exportList.fetchNextPage()}
          />
        </section>
      )}
    </div>
  );
}
