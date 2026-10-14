import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { useFormatters } from '@/tenancy';
import { link, useKindName } from '../components/common';
import { useImportBatches } from '../hooks/use-imports';
import type { ImportBatch } from '../types';

function Batches() {
  const { t } = useTranslation('imports');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const kindName = useKindName();
  const batches = useImportBatches();
  const rows = useMemo(
    () => batches.data?.pages.flatMap((page) => page.items) ?? [],
    [batches.data],
  );

  const columns = useMemo<GridColumn<ImportBatch>[]>(
    () => [
      {
        id: 'kind',
        header: t('columns.kind'),
        value: (row) => kindName(row.kind),
        hideable: false,
        render: (row, text) => (
          <Link to={`/imports/${row.id}`} className={link}>
            {text}
          </Link>
        ),
      },
      { id: 'status', header: t('columns.status'), value: (row) => t(`statuses.${row.status}`) },
      { id: 'rows', header: t('columns.rows'), value: (row) => format.number(row.rowCount) },
      {
        id: 'problems',
        header: t('columns.problems'),
        value: (row) => format.number(row.problemCount),
      },
      { id: 'createdBy', header: t('columns.createdBy'), value: (row) => row.createdBy.name },
      {
        id: 'createdAt',
        header: t('columns.createdAt'),
        value: (row) => format.dateTime(row.createdAt),
      },
    ],
    [t, format, kindName],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
        <Can permission="import:run">
          <Link to="/imports/new" className={`${link} pt-2 text-sm underline`}>
            {t('add')}
          </Link>
        </Can>
      </div>
      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => kindName(row.kind)}
        status={batches.isPending ? 'loading' : batches.isError ? 'error' : 'ready'}
        errorMessage={batches.isError ? tCommon(errorMessageKey(batches.error)) : undefined}
        onRetry={() => void batches.refetch()}
        emptyMessage={t('empty')}
        hasNextPage={batches.hasNextPage}
        loadingMore={batches.isFetchingNextPage}
        onLoadMore={() => void batches.fetchNextPage()}
      />
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function ImportList() {
  return (
    <DesktopOnly>
      <Batches />
    </DesktopOnly>
  );
}
