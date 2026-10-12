import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters, useTenant } from '@/tenancy';
import { usePriceChange, useServicePrices } from '../hooks/use-services';
import {
  createPriceFormSchema,
  currencyDigits,
  dayAfter,
  todayIn,
  toMinor,
  type PriceFormValues,
} from '../schemas';
import type { ServicePrice } from '../types';

const MANAGE = 'service:manage';

/** Where a price stands today: not yet in force, in force, or over. */
function standing(price: ServicePrice, today: string): 'scheduled' | 'inForce' | 'past' {
  if (price.effectiveFrom > today) return 'scheduled';
  return price.effectiveTo !== undefined && price.effectiveTo < today ? 'past' : 'inForce';
}

/** What the server said about a price, as a key of this feature's strings, when it has one. */
function refusal(error: unknown) {
  if (!isApiError(error)) return null;
  if (error.serverCode === 'price_date_conflict') return 'prices.errors.dateConflict' as const;
  if (error.serverCode === 'price_in_force') return 'prices.errors.inForce' as const;
  if (error.serverCode === 'price_not_found') return 'prices.errors.gone' as const;
  if (error.serverCode === 'service_archived') return 'prices.errors.archived' as const;
  return null;
}

/**
 * A service's prices on the standard list: the history, and for a manager the form that sets a
 * new price from a date. Nothing here edits a price that exists.
 *
 * The first price may start today. Once one is in force a new one starts tomorrow or later, so
 * what was charged this morning stays what it was; and one price at a time is scheduled.
 */
export function Prices({ serviceId, archived }: { serviceId: string; archived: boolean }) {
  const { t } = useTranslation('services');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const tenant = useTenant();
  const mayManage = usePermission(MANAGE);
  const prices = useServicePrices(serviceId);
  const change = usePriceChange(serviceId);
  const digits = currencyDigits(tenant?.currency);
  const today = todayIn(tenant?.timezone ?? 'UTC');
  // What was just done, said once in a status line.
  const [done, setDone] = useState<string | null>(null);
  // A key identifies one price as typed: sending the same again reuses it, so a repeat after a
  // lost answer sets one price and does not fail on its own.
  const attempt = useRef<{ body: string; key: string }>(undefined);

  const rows = useMemo(() => prices.data?.items ?? [], [prices.data]);
  const priced = rows.some((row) => row.effectiveFrom <= today);
  const scheduled = rows.some((row) => row.effectiveFrom > today);
  const earliest = priced ? dayAfter(today) : today;

  const schema = useMemo(() => createPriceFormSchema(digits, earliest), [digits, earliest]);
  const form = useZodForm(schema, { amount: '', effectiveFrom: '' });

  const columns = useMemo<GridColumn<ServicePrice>[]>(
    () => [
      {
        id: 'from',
        header: t('prices.columns.from'),
        value: (row) => format.calendarDate(row.effectiveFrom),
        hideable: false,
      },
      {
        id: 'to',
        header: t('prices.columns.to'),
        value: (row) =>
          row.effectiveTo ? format.calendarDate(row.effectiveTo) : t('prices.openEnded'),
      },
      {
        id: 'amount',
        header: t('prices.columns.amount'),
        value: (row) => format.money(row.amountMinor),
        align: 'end',
      },
      {
        id: 'status',
        header: t('prices.columns.status'),
        value: (row) => t(`prices.status.${standing(row, today)}`),
      },
    ],
    [t, format, today],
  );

  const actions: GridAction<ServicePrice>[] = [
    {
      id: 'withdraw',
      label: t('prices.withdraw'),
      requires: MANAGE,
      // Only a price that has not started: one that is or was in force is history.
      disabled: (row) => change.isPending || standing(row, today) !== 'scheduled',
      onSelect: (row) => {
        setDone(null);
        change.mutate({ cancel: row.id }, { onSuccess: () => setDone(t('prices.withdrawn')) });
      },
    },
  ];

  const submit = async (values: PriceFormValues) => {
    setDone(null);
    const amountMinor = toMinor(values.amount, digits);
    if (amountMinor === null) return;
    const set = { amountMinor, effectiveFrom: values.effectiveFrom };
    const body = JSON.stringify(set);
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    try {
      await change.mutateAsync({ set, idempotencyKey: attempt.current.key });
      attempt.current = undefined;
      setDone(t('prices.saved', { date: format.calendarDate(values.effectiveFrom) }));
      form.reset({ amount: '', effectiveFrom: '' });
    } catch {
      // Shown from the mutation state below.
    }
  };

  const refused = refusal(change.error);

  return (
    <section aria-labelledby="service-prices" className="flex flex-col gap-3">
      <div className="space-y-1">
        <h2 id="service-prices" className="text-lg font-semibold">
          {t('prices.heading')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('prices.description')}</p>
      </div>

      {change.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(change.error))}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {done ?? ''}
      </p>

      <DataGrid
        label={t('prices.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => format.calendarDate(row.effectiveFrom)}
        actions={actions}
        status={prices.isPending ? 'loading' : prices.isError ? 'error' : 'ready'}
        errorMessage={prices.isError ? t('prices.failed') : undefined}
        onRetry={() => void prices.refetch()}
        emptyMessage={t('prices.none')}
      />

      {mayManage && !archived && prices.isSuccess && (
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <h3 className="text-base font-semibold">{t('prices.newHeading')}</h3>
          {scheduled ? (
            // One price at a time is scheduled: the next one waits for this one to be withdrawn.
            <p className="text-sm text-muted-foreground">{t('prices.scheduledFirst')}</p>
          ) : (
            <Form form={form} onSubmit={submit} className="flex max-w-xl flex-col gap-4">
              <TextField
                name="amount"
                label={t('prices.amount', { currency: tenant?.currency ?? '' })}
                hint={t('prices.amountHint')}
                required
                inputMode="decimal"
                autoComplete="off"
                maxLength={20}
              />
              <TextField
                name="effectiveFrom"
                type="date"
                label={t('prices.effectiveFrom')}
                hint={t(priced ? 'prices.fromTomorrowHint' : 'prices.fromTodayHint')}
                required
                min={earliest}
              />
              <SubmitButton pending={change.isPending} className="self-start">
                {t('prices.submit')}
              </SubmitButton>
            </Form>
          )}
        </div>
      )}
    </section>
  );
}
