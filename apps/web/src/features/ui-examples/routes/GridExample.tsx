import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createTenantKeys, errorMessageKey } from '@/shared/api';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn, maskPhone } from '@/shared/utils/mask';
import { useFormatters, useTenant } from '@/tenancy';
import { fetchExamplePeople, type ExamplePerson, type PeopleSort } from '../api';
import { ExamplePage } from '../components/ExamplePage';

const peopleKeys = createTenantKeys('example_people');

export default function GridExample() {
  const { t } = useTranslation('ui_examples');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const tenantId = useTenant()?.id;
  const [sort, setSort] = useState<PeopleSort>(null);
  const [lastAction, setLastAction] = useState<string>();

  // The sort is part of the key: a new sort is a new server query, starting from the first page.
  const people = useInfiniteQuery({
    queryKey: peopleKeys.list(tenantId ?? '', { sort }),
    queryFn: ({ pageParam, signal }) => fetchExamplePeople({ cursor: pageParam, sort }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    placeholderData: (previous) => previous,
  });
  const rows = useMemo(() => people.data?.pages.flatMap((page) => page.items) ?? [], [people.data]);

  const columns = useMemo<GridColumn<ExamplePerson>[]>(
    () => [
      {
        id: 'name',
        header: t('grid.name'),
        value: (row) => row.name,
        sortable: true,
        hideable: false,
      },
      {
        id: 'department',
        header: t('grid.department'),
        value: (row) => t(`departments.${row.department}`),
      },
      // Masked in lists: the full value is not needed to pick the right row.
      { id: 'phone', header: t('grid.phone'), value: (row) => row.phone, mask: maskPhone },
      { id: 'mrn', header: t('grid.mrn'), value: (row) => row.mrn, mask: maskMrn, sortable: true },
      // Field-level access: the column exists only for roles that may see billing.
      {
        id: 'balance',
        header: t('grid.balance'),
        value: (row) => format.money(row.balanceMinor),
        align: 'end',
        requires: 'billing:read',
      },
    ],
    [t, format],
  );

  const actions = useMemo<GridAction<ExamplePerson>[]>(
    () => [
      {
        id: 'open',
        label: t('grid.open'),
        onSelect: (row) =>
          setLastAction(t('grid.lastAction', { action: t('grid.open'), name: row.name })),
      },
      {
        id: 'refund',
        label: t('grid.refund'),
        requires: 'billing:refund',
        disabled: (row) => row.balanceMinor <= 0,
        onSelect: (row) =>
          setLastAction(t('grid.lastAction', { action: t('grid.refund'), name: row.name })),
      },
    ],
    [t],
  );

  return (
    <ExamplePage heading={t('grid.heading')}>
      <p role="status" className="text-sm text-muted-foreground">
        {lastAction ?? t('grid.loaded', { count: rows.length })}
      </p>
      <DataGrid
        label={t('grid.label')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        status={people.isPending ? 'loading' : people.isError ? 'error' : 'ready'}
        errorMessage={people.isError ? tCommon(errorMessageKey(people.error)) : undefined}
        onRetry={() => void people.refetch()}
        emptyMessage={t('grid.empty')}
        sort={sort}
        onSortChange={(next) => setSort(next as PeopleSort)}
        actions={actions}
        hasNextPage={people.hasNextPage}
        loadingMore={people.isFetchingNextPage}
        onLoadMore={() => void people.fetchNextPage()}
      />
    </ExamplePage>
  );
}
