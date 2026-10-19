import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Slot } from '@/registry';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import type { QueueFilters } from '../api';
import { useQueueTokens } from '../hooks/use-queue';
import type { QueueToken } from '../types';
import { PriorityBadge } from './PriorityBadge';

/**
 * One group of today's queue (now serving, waiting or skipped) in call order, as the server
 * gives it. A table where there is room, cards on a phone, the token's number as the title.
 */
export function TokenGrid({
  filters,
  enabled,
  live,
  actions,
}: {
  filters: QueueFilters;
  enabled: boolean;
  live: boolean;
  actions: GridAction<QueueToken>[];
}) {
  const { t } = useTranslation('queue');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const tokens = useQueueTokens(filters, { enabled, live });
  const rows = useMemo(() => tokens.data?.pages.flatMap((page) => page.items) ?? [], [tokens.data]);
  const total = tokens.data?.pages[0]?.total;
  const called = filters.status === 'called';

  const columns = useMemo<GridColumn<QueueToken>[]>(
    () => [
      {
        id: 'token',
        header: t('columns.token'),
        value: (row) => t('token', { number: row.number }),
        hideable: false,
      },
      {
        id: 'patient',
        header: t('columns.patient'),
        value: (row) => row.patientName,
        hideable: false,
        render: (row, text) => (
          <span className="flex flex-col items-start gap-0.5">
            {text}
            {/* Other features' links for the token (triage's "Record vitals"), given ids and
                values only. Rendered for every row: a contribution reads no data of its own. */}
            <Slot
              id="queue.row.actions"
              context={{
                tokenId: row.id,
                patientId: row.patientId,
                number: row.number,
                status: row.status,
              }}
            />
          </span>
        ),
      },
      { id: 'mrn', header: t('columns.mrn'), value: (row) => row.patientMrn, mask: maskMrn },
      {
        id: 'priority',
        header: t('columns.priority'),
        value: (row) => (row.priority ? t(`priority.${row.priority}`) : ''),
        render: (row, text) => (row.priority ? <PriorityBadge>{text}</PriorityBadge> : null),
      },
      {
        id: 'doctor',
        header: t('columns.doctor'),
        value: (row) => row.doctorName ?? t('anyDoctor'),
      },
      { id: 'department', header: t('columns.department'), value: (row) => row.departmentName },
      called
        ? {
            id: 'called',
            header: t('columns.called'),
            value: (row) =>
              row.calledAt
                ? t('calledAt', { time: format.time(row.calledAt), count: row.callCount })
                : '',
          }
        : {
            id: 'issued',
            header: t('columns.issued'),
            value: (row) => format.time(row.issuedAt),
          },
    ],
    [t, format, called],
  );

  return (
    <>
      {/* Plain text, not a live region: the board changes all day by others' hands, and only
          what this person did is announced (the board's own status line). */}
      <p className="text-sm text-muted-foreground">
        {total === undefined || tokens.isPlaceholderData ? '' : t('count', { count: total })}
      </p>
      <DataGrid
        label={t(`groups.${filters.status}`)}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('rowLabel', { number: row.number, patient: row.patientName })}
        // Not on the previous filter's rows while the next are on their way.
        actions={tokens.isPlaceholderData ? [] : actions}
        status={tokens.isPending ? 'loading' : tokens.isError ? 'error' : 'ready'}
        errorMessage={tokens.isError ? tCommon(errorMessageKey(tokens.error)) : undefined}
        onRetry={() => void tokens.refetch()}
        emptyMessage={t(`empty.${filters.status}`)}
        hasNextPage={tokens.hasNextPage && !tokens.isPlaceholderData}
        total={tokens.isPlaceholderData ? undefined : total}
        loadingMore={tokens.isFetchingNextPage}
        onLoadMore={() => void tokens.fetchNextPage()}
      />
    </>
  );
}
