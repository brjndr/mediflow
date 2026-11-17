import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/shared/hooks/use-debounced-value';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { SearchInput } from '@/shared/ui/search-input';
import { StatusBadge } from '@/shared/ui/status-badge';
import { useFormatters } from '@/tenancy';
import { useDonors } from '../hooks/use-blood';
import { BLOOD_GROUPS } from '../schemas';
import type { BloodDonorSummary, BloodGroup, DonorStatus } from '../types';
import {
  CollectionDialog,
  DeferDialog,
  DonorDialog,
  EditDonorDialog,
  RegisterDonorDialog,
} from './DonorDialogs';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

type Open =
  | { kind: 'register' }
  | { kind: 'collect' | 'defer' | 'detail' | 'edit'; donor: BloodDonorSummary }
  | null;

/**
 * The Donors tab of the blood bank (#586): donors from `POST /blood/donors/search` with the name
 * and phone masked, registering a donor, recording a collection, deferring, and the full record
 * (read and audited by the server only when someone opens it).
 */
export function DonorsPanel() {
  const { t } = useTranslation('blood-bank');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState<BloodGroup | ''>('');
  const [status, setStatus] = useState<DonorStatus | ''>('');
  const q = useDebouncedValue(search, SEARCH_DEBOUNCE_MS).trim();
  const donors = useDonors({
    ...(q ? { q } : {}),
    ...(group ? { bloodGroup: group } : {}),
    ...(status ? { status } : {}),
  });
  const [open, setOpen] = useState<Open>(null);
  const [done, setDone] = useState<string>();
  const statusLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (done) focusIfLost(statusLine.current);
  }, [done]);

  const rows = useMemo(() => donors.data?.pages.flatMap((page) => page.items) ?? [], [donors.data]);
  const total = donors.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<BloodDonorSummary>[]>(
    () => [
      {
        id: 'donor',
        header: t('donor.columns.donor'),
        value: (row) => `${row.donorNumber} ${row.maskedName}`,
        hideable: false,
      },
      { id: 'group', header: t('columns.group'), value: (row) => row.bloodGroup },
      { id: 'sex', header: t('donor.sex'), value: (row) => t(`donor.sexes.${row.sex}`) },
      { id: 'phone', header: t('donor.phone'), value: (row) => row.maskedPhone ?? '' },
      {
        id: 'status',
        header: t('donor.columns.status'),
        hideable: false,
        value: (row) =>
          row.deferredPermanent
            ? t('donor.status.permanent')
            : row.status === 'deferred' && row.deferredUntil
              ? t('donor.status.until', { date: format.dateTime(row.deferredUntil) })
              : t('donor.status.active'),
        render: (row, text) => (
          <StatusBadge tone={row.status === 'active' ? 'success' : 'warning'} label={text} />
        ),
      },
      {
        id: 'lastDonated',
        header: t('donor.columns.lastDonated'),
        value: (row) => (row.lastDonatedAt ? format.dateTime(row.lastDonatedAt) : ''),
      },
    ],
    [t, format],
  );

  const actions: GridAction<BloodDonorSummary>[] = [
    {
      id: 'collect',
      label: t('donor.actions.collect'),
      requires: 'bloodDonor:manage',
      // The server decides (age, 90 days); a deferred donor is not offered at all.
      disabled: (row) => row.status === 'deferred',
      onSelect: (row) => setOpen({ kind: 'collect', donor: row }),
    },
    {
      id: 'edit',
      label: t('donor.actions.edit'),
      requires: 'bloodDonor:manage',
      disabled: () => false,
      onSelect: (row) => setOpen({ kind: 'edit', donor: row }),
    },
    {
      id: 'defer',
      label: t('donor.actions.defer'),
      requires: 'bloodDonor:manage',
      disabled: (row) => row.deferredPermanent,
      onSelect: (row) => setOpen({ kind: 'defer', donor: row }),
    },
    {
      id: 'detail',
      label: t('donor.actions.detail'),
      disabled: () => false,
      onSelect: (row) => setOpen({ kind: 'detail', donor: row }),
    },
  ];

  const finish = (message: string) => {
    setOpen(null);
    setDone(message);
  };

  return (
    <section aria-labelledby="blood-donors" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="blood-donors" className="text-lg font-semibold">
            {t('donor.heading')}
          </h2>
          <p className="text-muted-foreground">{t('donor.description')}</p>
        </div>
        <Can permission="bloodDonor:manage">
          <Button onClick={() => setOpen({ kind: 'register' })}>{t('donor.register.open')}</Button>
        </Can>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm font-medium">
          {t('donor.search')}
          <SearchInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('donor.searchHint')}
            maxLength={100}
          />
        </label>
        <label className="flex min-w-32 flex-col gap-1 text-sm font-medium">
          {t('filters.group')}
          <select
            value={group}
            onChange={(event) => setGroup(event.target.value as BloodGroup | '')}
            className={control}
          >
            <option value="">{t('filters.any')}</option>
            {BLOOD_GROUPS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-32 flex-col gap-1 text-sm font-medium">
          {t('filters.status')}
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as DonorStatus | '')}
            className={control}
          >
            <option value="">{t('filters.any')}</option>
            <option value="active">{t('donor.status.active')}</option>
            <option value="deferred">{t('donor.status.deferred')}</option>
          </select>
        </label>
      </div>

      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done ?? ''}
      </p>
      <p className="text-sm text-muted-foreground">
        {total === undefined || donors.isPlaceholderData ? '' : t('donor.count', { count: total })}
      </p>
      <DataGrid
        label={t('donor.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('donor.rowLabel', { number: row.donorNumber, group: row.bloodGroup })}
        actions={donors.isPlaceholderData ? [] : actions}
        status={donors.isPending ? 'loading' : donors.isError ? 'error' : 'ready'}
        errorMessage={donors.isError ? tCommon(errorMessageKey(donors.error)) : undefined}
        onRetry={() => void donors.refetch()}
        emptyMessage={t('donor.empty')}
        hasNextPage={donors.hasNextPage && !donors.isPlaceholderData}
        total={donors.isPlaceholderData ? undefined : total}
        loadingMore={donors.isFetchingNextPage}
        onLoadMore={() => void donors.fetchNextPage()}
      />

      {open?.kind === 'register' && (
        <RegisterDonorDialog
          onClose={() => setOpen(null)}
          onDone={(donor) => finish(t('donor.done.registered', { number: donor.donorNumber }))}
        />
      )}
      {open?.kind === 'collect' && (
        <CollectionDialog
          donor={open.donor}
          onClose={() => setOpen(null)}
          onDone={(_collection, unitNumbers) =>
            finish(
              t('donor.done.collected', {
                count: unitNumbers.length,
                number: open.donor.donorNumber,
                units: unitNumbers.join(', '),
              }),
            )
          }
        />
      )}
      {open?.kind === 'defer' && (
        <DeferDialog
          donor={open.donor}
          onClose={() => setOpen(null)}
          onDone={(donor) => finish(t('donor.done.deferred', { number: donor.donorNumber }))}
        />
      )}
      {open?.kind === 'edit' && (
        <EditDonorDialog
          donor={open.donor}
          onClose={() => setOpen(null)}
          onDone={(saved) => finish(t('donor.done.edited', { number: saved.donorNumber }))}
        />
      )}
      {open?.kind === 'detail' && <DonorDialog donor={open.donor} onClose={() => setOpen(null)} />}
    </section>
  );
}
