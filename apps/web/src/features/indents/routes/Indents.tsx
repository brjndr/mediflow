import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { buttonVariants } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { field } from '../components/field';
import { useIndentPlaces, useIndents } from '../hooks/use-indents';
import { INDENT_STATUSES } from '../schemas';
import type { StockIndentStatus, StockIndentSummary } from '../types';

/**
 * Indents (`inventory/indents`, #105), for `indent:read`: the newest asked first, of every status
 * or one, and of every place or one (the place that asked or the store asked), each with the
 * places, its status in words, its items and who asked. **New indent** (`indent:create`); **Open**
 * shows one. Works at every width.
 */
export default function Indents() {
  const { t } = useTranslation('indents');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const statusFieldId = useId();
  const placeFieldId = useId();
  const [status, setStatus] = useState<StockIndentStatus | ''>('');
  const [placeId, setPlaceId] = useState('');
  const places = useIndentPlaces();
  const indents = useIndents(status, placeId);
  const rows = useMemo(
    () => indents.data?.pages.flatMap((page) => page.items) ?? [],
    [indents.data],
  );
  const total = indents.isPlaceholderData ? undefined : indents.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<StockIndentSummary>[]>(
    () => [
      {
        id: 'reference',
        header: t('list.columns.reference'),
        value: (row) => row.reference,
        hideable: false,
      },
      { id: 'from', header: t('list.columns.from'), value: (row) => row.fromLocationName },
      { id: 'to', header: t('list.columns.to'), value: (row) => row.toLocationName },
      {
        id: 'status',
        header: t('list.columns.status'),
        value: (row) => t(`status.${row.status}`),
      },
      {
        id: 'lines',
        header: t('list.columns.lines'),
        value: (row) => t('list.lineCount', { count: row.lineCount }),
      },
      {
        id: 'asked',
        header: t('list.columns.asked'),
        value: (row) =>
          t('by', { name: row.requestedByName, time: format.dateTime(row.requestedAt) }),
      },
    ],
    [t, format],
  );

  const actions: GridAction<StockIndentSummary>[] = [
    {
      id: 'open',
      label: t('list.open'),
      onSelect: (row) => navigate(`/inventory/indents/${row.id}`),
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('list.heading')}</h1>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-full flex-col gap-1.5 sm:w-56">
          <label htmlFor={statusFieldId} className="text-sm font-medium">
            {t('list.show')}
          </label>
          <select
            id={statusFieldId}
            className={field}
            value={status}
            onChange={(event) => setStatus(event.target.value as StockIndentStatus | '')}
          >
            <option value="">{t('list.every')}</option>
            {INDENT_STATUSES.map((each) => (
              <option key={each} value={each}>
                {t(`status.${each}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex w-full flex-col gap-1.5 sm:w-64">
          <label htmlFor={placeFieldId} className="text-sm font-medium">
            {t('list.place')}
          </label>
          <select
            id={placeFieldId}
            className={field}
            value={placeId}
            onChange={(event) => setPlaceId(event.target.value)}
          >
            <option value="">{t('list.everyPlace')}</option>
            {(places.data?.items ?? []).map((place) => (
              <option key={place.id} value={place.id}>
                {place.name}
              </option>
            ))}
          </select>
        </div>
        <Can permission="indent:create">
          <Link to="/inventory/indents/new" className={buttonVariants()}>
            {t('list.new')}
          </Link>
        </Can>
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {total === undefined ? '' : t('list.count', { count: total })}
      </p>
      <DataGrid
        label={t('list.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.reference}
        actions={actions}
        status={indents.isPending ? 'loading' : indents.isError ? 'error' : 'ready'}
        errorMessage={indents.isError ? tCommon(errorMessageKey(indents.error)) : undefined}
        onRetry={() => void indents.refetch()}
        emptyMessage={t('list.empty')}
        hasNextPage={indents.hasNextPage && !indents.isPlaceholderData}
        total={total}
        loadingMore={indents.isFetchingNextPage}
        onLoadMore={() => void indents.fetchNextPage()}
      />
    </div>
  );
}
