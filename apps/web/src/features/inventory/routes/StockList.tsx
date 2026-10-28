import { AlertTriangle } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { field } from '../components/field';
import { InventoryLinks } from '../components/InventoryLinks';
import { ItemPicker, type PickedItem } from '../components/ItemPicker';
import { useAlertCounts, usePlaces, useStock } from '../hooks/use-inventory';
import { useItemName } from '../hooks/use-item-name';
import { ALERTS, EXPIRING_DEFAULT, EXPIRING_WINDOWS } from '../schemas';
import type { StockAlert, StockItem } from '../types';

/**
 * The stock (`inventory`, #102), for `stock:read`: every item in use of the drug and consumable
 * master, by name, with its units at the place chosen (or the whole hospital) and at the whole
 * hospital, its reorder level, whether the hospital is low on it, and its batches with stock,
 * soonest expiry first, each with its place and whether it is expiring or expired. The alert
 * counts above the list narrow it to low, expiring or expired items; the window of "expiring"
 * is chosen. A row opens its ledger, or an adjustment of it (`stock:adjust`). Works at every
 * width.
 */
export default function StockList() {
  const { t } = useTranslation('inventory');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const nameOf = useItemName();
  const placeFieldId = useId();
  const alertFieldId = useId();
  const windowFieldId = useId();
  const [locationId, setLocationId] = useState('');
  const [alert, setAlert] = useState<StockAlert | ''>('');
  const [expiringWithinDays, setWindow] = useState<number>(EXPIRING_DEFAULT);
  const [item, setItem] = useState<PickedItem | null>(null);
  const places = usePlaces();
  const stock = useStock({ locationId, drugId: item?.id ?? '', alert, expiringWithinDays });
  const counts = useAlertCounts({ locationId, expiringWithinDays });
  const rows = useMemo(() => stock.data?.pages.flatMap((page) => page.items) ?? [], [stock.data]);
  const total = stock.isPlaceholderData ? undefined : stock.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<StockItem>[]>(
    () => [
      {
        id: 'item',
        header: t('stock.columns.item'),
        value: (row) => nameOf(row.item),
        hideable: false,
      },
      {
        id: 'onHand',
        header: t(locationId ? 'stock.columns.onHandHere' : 'stock.columns.onHand'),
        value: (row) =>
          row.item.unit
            ? t('stock.units', {
                count: row.onHand,
                number: format.number(row.onHand),
                unit: row.item.unit,
              })
            : format.number(row.onHand),
        align: 'end',
      },
      {
        id: 'hospital',
        header: t('stock.columns.hospital'),
        value: (row) => format.number(row.hospitalOnHand),
        align: 'end',
      },
      {
        id: 'reorder',
        header: t('stock.columns.reorder'),
        value: (row) => (row.reorderLevel === undefined ? '' : format.number(row.reorderLevel)),
        align: 'end',
      },
      {
        id: 'state',
        header: t('stock.columns.state'),
        value: (row) => (row.low ? t('stock.low') : ''),
        render: (row) =>
          row.low ? (
            <span className="inline-flex items-center gap-1 font-semibold text-destructive">
              <AlertTriangle aria-hidden className="size-4" />
              {t('stock.low')}
            </span>
          ) : (
            ''
          ),
      },
      {
        id: 'batches',
        header: t('stock.columns.batches'),
        value: (row) =>
          row.batches
            .map((batch) =>
              t(`stock.batch.${batch.expiry}`, {
                number: batch.batchNumber,
                expiry: format.calendarDate(batch.expiryDate),
                place: batch.locationName,
                count: batch.onHand,
              }),
            )
            .join('; ') || t('stock.noBatches'),
        render: (row) =>
          row.batches.length === 0 ? (
            t('stock.noBatches')
          ) : (
            <ul className="flex flex-col gap-1">
              {row.batches.map((batch) => (
                <li
                  key={`${batch.batchId}:${batch.locationId}`}
                  className={batch.expiry === 'ok' ? undefined : 'font-semibold text-destructive'}
                >
                  {t(`stock.batch.${batch.expiry}`, {
                    number: batch.batchNumber,
                    expiry: format.calendarDate(batch.expiryDate),
                    place: batch.locationName,
                    count: batch.onHand,
                  })}
                </li>
              ))}
            </ul>
          ),
      },
    ],
    [t, format, nameOf, locationId],
  );

  const actions: GridAction<StockItem>[] = [
    {
      id: 'ledger',
      label: t('stock.ledger'),
      onSelect: (row) =>
        navigate(`/inventory/ledger?drugId=${encodeURIComponent(row.item.drugId)}`),
    },
    {
      id: 'adjust',
      label: t('stock.adjust'),
      requires: 'stock:adjust',
      onSelect: (row) =>
        // The item travels in the router's state, in memory: never in the address.
        navigate('/inventory/adjustments', {
          state: { adjust: { id: row.item.drugId, name: nameOf(row.item) } },
        }),
    },
    {
      // An expired batch is written off by an adjustment another person approves (#104): the
      // panel starts with the soonest expired batch shown, all its units at its place.
      id: 'writeOff',
      label: t('stock.writeOff'),
      requires: 'stock:adjust',
      disabled: (row) => !row.batches.some((batch) => batch.expiry === 'expired'),
      onSelect: (row) => {
        const batch = row.batches.find((each) => each.expiry === 'expired');
        if (!batch) return;
        navigate('/inventory/adjustments', {
          state: {
            adjust: {
              id: row.item.drugId,
              name: nameOf(row.item),
              writeOff: {
                batchId: batch.batchId,
                locationId: batch.locationId,
                quantity: batch.onHand,
              },
            },
          },
        });
      },
    },
  ];

  const alertCount = (each: StockAlert) => counts.data?.[each];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('stock.heading')}</h1>
        <InventoryLinks />
      </div>
      <div role="group" aria-label={t('stock.alerts')} className="flex flex-wrap gap-2">
        {ALERTS.map((each) => (
          <Button
            key={each}
            type="button"
            variant={alert === each ? 'default' : 'outline'}
            size="sm"
            aria-pressed={alert === each}
            onClick={() => setAlert(alert === each ? '' : each)}
          >
            {t(`stock.alert.${each}`, { count: alertCount(each) ?? 0 })}
          </Button>
        ))}
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
        <div className="flex flex-col gap-1.5">
          <label htmlFor={alertFieldId} className="text-sm font-medium">
            {t('stock.show')}
          </label>
          <select
            id={alertFieldId}
            className={field}
            value={alert}
            onChange={(event) => setAlert(event.target.value as StockAlert | '')}
          >
            <option value="">{t('stock.allItems')}</option>
            {ALERTS.map((each) => (
              <option key={each} value={each}>
                {t(`stock.only.${each}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={windowFieldId} className="text-sm font-medium">
            {t('stock.window')}
          </label>
          <select
            id={windowFieldId}
            className={field}
            value={expiringWithinDays}
            onChange={(event) => setWindow(Number(event.target.value))}
          >
            {EXPIRING_WINDOWS.map((days) => (
              <option key={days} value={days}>
                {t('stock.days', { count: days })}
              </option>
            ))}
          </select>
        </div>
        <ItemPicker label={t('stock.item')} value={item} onChange={setItem} />
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {total === undefined ? '' : t('stock.count', { count: total })}
      </p>
      <DataGrid
        label={t('stock.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.item.drugId}
        rowLabel={(row) => nameOf(row.item)}
        actions={actions}
        status={stock.isPending ? 'loading' : stock.isError ? 'error' : 'ready'}
        errorMessage={stock.isError ? tCommon(errorMessageKey(stock.error)) : undefined}
        onRetry={() => void stock.refetch()}
        emptyMessage={t(alert ? `stock.empty.${alert}` : 'stock.empty.all')}
        hasNextPage={stock.hasNextPage && !stock.isPlaceholderData}
        total={total}
        loadingMore={stock.isFetchingNextPage}
        onLoadMore={() => void stock.fetchNextPage()}
      />
    </div>
  );
}
