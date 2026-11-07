import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import type { BoardFilters } from '../api';
import { useBoard } from '../hooks/use-board';
import type { BoardBed } from '../types';
import { StatusBadge } from './StatusBadge';

/** The beds in use by ward and bed number, as the server gives them. The bed names the row. */
export function BedGrid({
  filters,
  live,
  actions,
}: {
  filters: BoardFilters;
  live: boolean;
  actions: GridAction<BoardBed>[];
}) {
  const { t } = useTranslation('admissions');
  const { t: tCommon } = useTranslation();
  const beds = useBoard(filters, live);
  const rows = useMemo(() => beds.data?.pages.flatMap((page) => page.items) ?? [], [beds.data]);
  const total = beds.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<BoardBed>[]>(
    () => [
      { id: 'bed', header: t('columns.bed'), value: (row) => row.number, hideable: false },
      { id: 'ward', header: t('columns.ward'), value: (row) => row.wardName },
      { id: 'room', header: t('columns.room'), value: (row) => row.roomName },
      { id: 'category', header: t('columns.category'), value: (row) => row.categoryName },
      {
        id: 'status',
        header: t('columns.status'),
        value: (row) =>
          row.status === 'blocked' && row.blockedReason
            ? t('status.blockedFor', { reason: t(`reasons.${row.blockedReason}`) })
            : t(`status.${row.status}`),
        render: (row) => <StatusBadge bed={row} />,
        hideable: false,
      },
      {
        id: 'patient',
        header: t('columns.patient'),
        value: (row) => row.occupant?.patientName ?? '',
      },
      {
        id: 'mrn',
        header: t('columns.mrn'),
        value: (row) => row.occupant?.patientMrn ?? '',
        mask: maskMrn,
      },
    ],
    [t],
  );

  return (
    <>
      {/* Plain text, not a live region: the board changes all day by others' hands, and only
          what this person did is announced (the board's own status line). */}
      <p className="text-sm text-muted-foreground">
        {total === undefined || beds.isPlaceholderData ? '' : t('count', { count: total })}
      </p>
      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('rowLabel', { number: row.number, ward: row.wardName })}
        // Not on the previous filter's rows while the next are on their way.
        actions={beds.isPlaceholderData ? [] : actions}
        status={beds.isPending ? 'loading' : beds.isError ? 'error' : 'ready'}
        errorMessage={beds.isError ? tCommon(errorMessageKey(beds.error)) : undefined}
        onRetry={() => void beds.refetch()}
        emptyMessage={t('empty')}
        hasNextPage={beds.hasNextPage && !beds.isPlaceholderData}
        total={beds.isPlaceholderData ? undefined : total}
        loadingMore={beds.isFetchingNextPage}
        onLoadMore={() => void beds.fetchNextPage()}
      />
    </>
  );
}
