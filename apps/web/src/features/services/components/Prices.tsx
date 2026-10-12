import { useMemo, useState } from 'react';
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
  return null;
}

/**
 * A service's prices on the standard list: the history, and for a manager the form that sets a
 * new price from a date. Nothing here edits a price that exists.
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

  const schema = useMemo(() => createPriceFormSchema(digits, today), [digits, today]);
  const form = useZodForm(schema, { amount: '', effectiveFrom: today });

  // A calendar date, not an instant: noon UTC keeps the day the same in every timezone.
  const day = (date: string) => format.date(`${date}T12:00:00Z`);
  const rows = prices.data?.items ?? [];

  const columns = useMemo<GridColumn<ServicePrice>[]>(
    () => [
      {
        id: 'from',
        header: t('prices.columns.from'),
        value: (row) => format.date(`${row.effectiveFrom}T12:00:00Z`),
        hideable: false,
      },
      {
        id: 'to',
        header: t('prices.columns.to'),
        value: (row) =>
          row.effectiveTo ? format.date(`${row.effectiveTo}T12:00:00Z`) : t('prices.openEnded'),
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
    try {
      await change.mutateAsync({ set: { amountMinor, effectiveFrom: values.effectiveFrom } });
      setDone(t('prices.saved', { date: day(values.effectiveFrom) }));
      form.reset({ amount: '', effectiveFrom: today });
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
        rowLabel={(row) => day(row.effectiveFrom)}
        actions={actions}
        status={prices.isPending ? 'loading' : prices.isError ? 'error' : 'ready'}
        errorMessage={prices.isError ? t('prices.failed') : undefined}
        onRetry={() => void prices.refetch()}
        emptyMessage={t('prices.none')}
      />

      {mayManage && !archived && (
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <h3 className="text-base font-semibold">{t('prices.newHeading')}</h3>
          <Form form={form} onSubmit={submit} className="flex max-w-xl flex-col gap-4">
            <TextField
              name="amount"
              label={t('prices.amount', { currency: tenant?.currency ?? '' })}
              required
              inputMode="decimal"
              autoComplete="off"
              maxLength={20}
            />
            <TextField
              name="effectiveFrom"
              type="date"
              label={t('prices.effectiveFrom')}
              hint={t('prices.effectiveFromHint')}
              required
              min={today}
            />
            <SubmitButton pending={change.isPending} className="self-start">
              {t('prices.submit')}
            </SubmitButton>
          </Form>
        </div>
      )}
    </section>
  );
}
