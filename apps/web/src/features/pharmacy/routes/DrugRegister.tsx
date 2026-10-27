import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DrugSearch, useMedicineName } from '@/features/drugs';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { todayIn } from '@/shared/utils';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters, useTenant } from '@/tenancy';
import { PharmacyLinks } from '../components/PharmacyLinks';
import { useRegister } from '../hooks/use-sales';
import { REGISTER_DAYS_MAX } from '../sales-schemas';
import type { DrugRegisterEntry } from '../types';

const field =
  'h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** A calendar date `days` before another, both `YYYY-MM-DD`. */
const daysBefore = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

const SOURCES = new Set(['adjustment', 'dispense', 'sale', 'sale_return']);

/**
 * The drug register (`pharmacy/register`, #101), for `drugRegister:read`: every movement of an
 * item of schedule H1, X, narcotic or controlled between two days, the oldest first, read from
 * the stock ledger, so no dispense, sale or return of it is missing. Each says what moved the
 * stock, the batch, the units in or out and the batch's balance after, who it was for (the MRN
 * masked), who prescribed it, and who made it. Works at every width.
 */
export default function DrugRegister() {
  const { t } = useTranslation('pharmacy');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const nameOf = useMedicineName();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const today = todayIn(timezone);
  const fromId = useId();
  const toId = useId();
  const [item, setItem] = useState<{ id: string; name: string } | null>(null);
  const [from, setFrom] = useState(() => daysBefore(today, 29));
  const [to, setTo] = useState(today);
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  const rangeValid = !Number.isNaN(span) && span >= 0 && span < REGISTER_DAYS_MAX;
  const register = useRegister(item && rangeValid ? { drugId: item.id, from, to } : null);
  const rows = useMemo(
    () => register.data?.pages.flatMap((page) => page.items) ?? [],
    [register.data],
  );
  const total = register.data?.pages[0]?.total;
  const notRegister =
    isApiError(register.error) && register.error.serverCode === 'not_a_register_item';

  const changeBox = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  useLayoutEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    changeBox.current?.querySelector<HTMLElement>(item ? 'button' : 'input')?.focus();
  }, [item]);

  const columns = useMemo<GridColumn<DrugRegisterEntry>[]>(
    () => [
      {
        id: 'at',
        header: t('register.columns.at'),
        value: (row) => format.dateTime(row.at),
        hideable: false,
      },
      {
        id: 'movement',
        header: t('register.columns.movement'),
        value: (row) =>
          t(SOURCES.has(row.source) ? `register.sources.${row.source}` : 'register.sources.other'),
      },
      {
        id: 'units',
        header: t('register.columns.units'),
        value: (row) =>
          t(row.quantity > 0 ? 'register.in' : 'register.out', { count: Math.abs(row.quantity) }),
      },
      {
        id: 'balance',
        header: t('register.columns.balance'),
        value: (row) =>
          t('register.balance', {
            count: row.balanceAfter,
            number: row.batchNumber,
            place: row.locationName,
          }),
      },
      {
        id: 'patient',
        header: t('register.columns.patient'),
        value: (row) =>
          row.patientName
            ? t('detail.patient', { name: row.patientName, mrn: maskMrn(row.patientMrn ?? '') })
            : '',
      },
      {
        id: 'prescriber',
        header: t('register.columns.prescriber'),
        value: (row) =>
          row.prescriberName
            ? row.prescriberRegistration
              ? t('register.outsidePrescriber', {
                  name: row.prescriberName,
                  registration: row.prescriberRegistration,
                })
              : row.prescriberName
            : '',
      },
      { id: 'by', header: t('register.columns.by'), value: (row) => row.actorName },
    ],
    [t, format],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <PharmacyLinks />
      <h1 className="text-2xl font-semibold tracking-tight">{t('register.heading')}</h1>
      <p className="text-sm text-muted-foreground">{t('register.intro')}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div ref={changeBox} className="md:col-span-3 lg:col-span-1">
          {item ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t('register.item')}</span>
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-words text-sm">{item.name}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t('register.changeItem', { name: item.name })}
                  onClick={() => {
                    moved.current = true;
                    setItem(null);
                  }}
                >
                  {t('register.change')}
                </Button>
              </div>
            </div>
          ) : (
            <DrugSearch
              label={t('register.item')}
              onSelect={(drug) => {
                moved.current = true;
                setItem({ id: drug.id, name: nameOf(drug) });
              }}
            />
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={fromId} className="text-sm font-medium">
            {t('register.from')}
          </label>
          <input
            id={fromId}
            type="date"
            className={field}
            value={from}
            max={to}
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={toId} className="text-sm font-medium">
            {t('register.to')}
          </label>
          <input
            id={toId}
            type="date"
            className={field}
            value={to}
            min={from}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {!rangeValid
          ? t('register.badRange', { count: REGISTER_DAYS_MAX })
          : !item
            ? t('register.chooseItem')
            : notRegister
              ? t('register.notRegister')
              : total === undefined
                ? ''
                : t('register.count', { count: total })}
      </p>
      {item && rangeValid && !notRegister && (
        <DataGrid
          label={t('register.heading')}
          columns={columns}
          rows={rows}
          rowId={(row) => row.id}
          rowLabel={(row) => format.dateTime(row.at)}
          status={register.isPending ? 'loading' : register.isError ? 'error' : 'ready'}
          errorMessage={register.isError ? tCommon(errorMessageKey(register.error)) : undefined}
          onRetry={() => void register.refetch()}
          emptyMessage={t('register.empty')}
          hasNextPage={register.hasNextPage}
          total={total}
          loadingMore={register.isFetchingNextPage}
          onLoadMore={() => void register.fetchNextPage()}
        />
      )}
    </div>
  );
}
