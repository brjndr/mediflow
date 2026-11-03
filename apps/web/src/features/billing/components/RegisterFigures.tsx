import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { cashOf, differenceText, netOf, totalsInOrder } from '../lib/register';
import type { RegisterSession, RegisterTotal } from '../types';

/**
 * What a session took by payment mode and how its expected cash is worked out: opening cash plus
 * cash taken less cash refunded. Shown for an open drawer (so far) and a settled one.
 */
export function RegisterFigures({ session }: { session: RegisterSession }) {
  const { t } = useTranslation('billing');
  const format = useFormatters();
  const rows = totalsInOrder(session);
  const { takenMinor, refundedMinor } = cashOf(session);

  const columns = useMemo<GridColumn<RegisterTotal>[]>(
    () => [
      {
        id: 'method',
        header: t('register.totals.method'),
        value: (row) => t(`payment.methods.${row.method}`),
        hideable: false,
      },
      {
        id: 'taken',
        header: t('register.totals.taken'),
        value: (row) => format.money(row.paidMinor),
        align: 'end',
      },
      {
        id: 'refunded',
        header: t('register.totals.refunded'),
        value: (row) => format.money(row.refundedMinor),
        align: 'end',
      },
      {
        id: 'net',
        header: t('register.totals.net'),
        value: (row) => format.money(netOf(row)),
        align: 'end',
      },
    ],
    [t, format],
  );

  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby={`totals-${session.id}`} className="flex flex-col gap-2">
        <h2 id={`totals-${session.id}`} className="text-lg font-semibold">
          {t('register.totals.heading')}
        </h2>
        <DataGrid
          label={t('register.totals.heading')}
          columns={columns}
          rows={rows}
          rowId={(row) => row.method}
          rowLabel={(row) => t(`payment.methods.${row.method}`)}
          status="ready"
          emptyMessage={t('register.totals.none')}
        />
        <p className="text-sm font-medium" data-testid="net-all">
          {t('register.totals.all')}:{' '}
          {format.money(rows.reduce((sum, each) => sum + netOf(each), 0))}
        </p>
      </section>
      <section aria-labelledby={`working-${session.id}`} className="flex flex-col gap-1">
        <h2 id={`working-${session.id}`} className="text-lg font-semibold">
          {t('register.working.heading')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('register.working.cashOnly')}</p>
        <p className="text-sm" data-testid="working">
          {t('register.working.line', {
            opening: format.money(session.openingMinor),
            taken: format.money(takenMinor),
            refunded: format.money(refundedMinor),
            expected: format.money(session.expectedMinor),
          })}
        </p>
        {session.differenceMinor !== undefined && (
          <p className="text-sm font-medium" data-testid="difference">
            {differenceText(session.differenceMinor, t, format.money)}
          </p>
        )}
      </section>
    </div>
  );
}
