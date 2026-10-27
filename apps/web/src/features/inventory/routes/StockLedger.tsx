import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { nextDay, zonedToUtc } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { field } from '../components/field';
import { InventoryLinks } from '../components/InventoryLinks';
import { ItemPicker, type PickedItem } from '../components/ItemPicker';
import { useLedger, usePlaces } from '../hooks/use-inventory';
import { useItemName } from '../hooks/use-item-name';
import type { StockLedgerEntry } from '../types';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The stock ledger (`inventory/ledger`, #102), for `stock:read`: every change of stock, newest
 * first, with the batch, the place, the change in or out, the batch's stock at the place after
 * it, the reason and who made it. Filtered by place, item (from the address when opened from the
 * stock list: an id, nothing else) and a range of days at the hospital. Append-only, so it has
 * no count. Works at every width.
 */
export default function StockLedger() {
  const { t } = useTranslation('inventory');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const nameOf = useItemName();
  const placeFieldId = useId();
  const fromFieldId = useId();
  const toFieldId = useId();
  const [params] = useSearchParams();
  const [locationId, setLocationId] = useState('');
  const [item, setItem] = useState<PickedItem | null>(() => {
    const id = params.get('drugId');
    return id ? { id, name: '' } : null;
  });
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const places = usePlaces();
  const ledger = useLedger({
    drugId: item?.id ?? '',
    batchId: '',
    locationId,
    from: DAY.test(fromDay) ? zonedToUtc(fromDay, '00:00', timezone) : '',
    to: DAY.test(toDay) ? zonedToUtc(nextDay(toDay), '00:00', timezone) : '',
  });
  const rows = useMemo(() => ledger.data?.pages.flatMap((page) => page.items) ?? [], [ledger.data]);
  // An item named by the address alone reads its name from its entries.
  const shown =
    item && item.name === '' && rows[0] ? { ...item, name: nameOf(rows[0].item) } : item;

  const columns = useMemo<GridColumn<StockLedgerEntry>[]>(
    () => [
      {
        id: 'item',
        header: t('ledger.columns.item'),
        value: (row) => nameOf(row.item),
        hideable: false,
      },
      { id: 'at', header: t('ledger.columns.at'), value: (row) => format.dateTime(row.at) },
      {
        id: 'change',
        header: t('ledger.columns.change'),
        value: (row) =>
          t(row.quantity > 0 ? 'change.in' : 'change.out', { count: Math.abs(row.quantity) }),
      },
      {
        id: 'balance',
        header: t('ledger.columns.balance'),
        value: (row) => format.number(row.balanceAfter),
        align: 'end',
      },
      {
        id: 'batch',
        header: t('ledger.columns.batch'),
        value: (row) =>
          t('adjustments.batch', {
            number: row.batchNumber,
            expiry: format.calendarDate(row.expiryDate),
          }),
      },
      { id: 'place', header: t('ledger.columns.place'), value: (row) => row.locationName },
      {
        id: 'reason',
        header: t('ledger.columns.reason'),
        value: (row) => t(`reason.${row.reason}`),
      },
      { id: 'by', header: t('ledger.columns.by'), value: (row) => row.actorName },
    ],
    [t, format, nameOf],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('ledger.heading')}</h1>
        <InventoryLinks />
        <p className="text-sm text-muted-foreground">{t('ledger.description')}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={placeFieldId} className="text-sm font-medium">
            {t('stock.place')}
          </label>
          <select
            id={placeFieldId}
            className={field}
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
          >
            <option value="">{t('stock.allPlaces')}</option>
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.name}
              </option>
            ))}
          </select>
        </div>
        <ItemPicker
          label={t('stock.item')}
          value={shown && shown.name === '' ? { ...shown, name: t('ledger.oneItem') } : shown}
          onChange={setItem}
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={fromFieldId} className="text-sm font-medium">
            {t('ledger.from')}
          </label>
          <input
            id={fromFieldId}
            type="date"
            className={field}
            value={fromDay}
            onChange={(event) => setFromDay(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={toFieldId} className="text-sm font-medium">
            {t('ledger.to')}
          </label>
          <input
            id={toFieldId}
            type="date"
            className={field}
            value={toDay}
            onChange={(event) => setToDay(event.target.value)}
          />
        </div>
      </div>
      <DataGrid
        label={t('ledger.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) =>
          t('ledger.rowLabel', { item: nameOf(row.item), time: format.dateTime(row.at) })
        }
        status={ledger.isPending ? 'loading' : ledger.isError ? 'error' : 'ready'}
        errorMessage={ledger.isError ? tCommon(errorMessageKey(ledger.error)) : undefined}
        onRetry={() => void ledger.refetch()}
        emptyMessage={t('ledger.empty')}
        hasNextPage={ledger.hasNextPage && !ledger.isPlaceholderData}
        loadingMore={ledger.isFetchingNextPage}
        onLoadMore={() => void ledger.fetchNextPage()}
      />
    </div>
  );
}
