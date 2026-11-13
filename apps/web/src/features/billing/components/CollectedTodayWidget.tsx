import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useWidgetStrings } from '@/shared/hooks/use-widget-strings';
import widgetStrings from '../widget-strings.json';
import { errorMessageKey } from '@/shared/api';
import { Card } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { useFormatters } from '@/tenancy';
import { useCollectedToday } from '../hooks/use-billing';
import { netOf } from '../lib/register';
import type { RegisterTotal } from '../types';
import { Link } from 'react-router-dom';

const METHODS: RegisterTotal['method'][] = ['cash', 'card', 'upi', 'bank', 'other'];

/**
 * What the hospital took today, net of refunds, with the split by payment mode, from
 * `GET /cash-registers/collected` (the payments themselves, not register sessions). Amounts only:
 * no patient, invoice or payer. Default export: a `dashboard.widgets` contribution.
 */
export default function CollectedTodayWidget() {
  const { t } = useWidgetStrings('billing-widget', widgetStrings);
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const sessions = useCollectedToday();

  const figures = useMemo(() => {
    if (!sessions.data) return undefined;
    const split = METHODS.flatMap((method) => {
      const row = sessions.data.totals.find((each) => each.method === method);
      return row ? [{ method, minor: netOf(row) }] : [];
    });
    return { split, total: sessions.data.netMinor };
  }, [sessions.data]);

  return (
    <Card variant="brand" asChild>
      <section aria-labelledby="widget-collected" className="flex flex-col gap-2">
        <h2 id="widget-collected" className="text-sm font-medium">
          {t('collected.title')}
        </h2>
        {sessions.isError ? (
          <p role="alert" className="text-sm">
            {tCommon(errorMessageKey(sessions.error))}
          </p>
        ) : !figures ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <p className="text-3xl font-semibold tabular-nums">{format.money(figures.total)}</p>
            {figures.split.length === 0 ? (
              <p className="text-sm">{t('collected.empty')}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {figures.split.map((each) => (
                  <li key={each.method} className="flex justify-between gap-2">
                    <span>{t(`payment.methods.${each.method}`)}</span>
                    <span className="tabular-nums">{format.money(each.minor)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <Link
          to="/billing/register/sessions"
          className="mt-auto inline-flex text-sm underline underline-offset-4 pointer-coarse:min-h-11 pointer-coarse:items-center"
        >
          {t('collected.open')}
        </Link>
      </section>
    </Card>
  );
}
