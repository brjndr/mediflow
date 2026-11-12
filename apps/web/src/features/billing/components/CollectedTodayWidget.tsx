import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Card } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { dayBoundsUtc, todayIn } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { useRegisterSessions } from '../hooks/use-billing';
import { netOf } from '../lib/register';
import type { RegisterTotal } from '../types';
import { Link } from 'react-router-dom';

const PAGE = 25;
const METHODS: RegisterTotal['method'][] = ['cash', 'card', 'upi', 'bank', 'other'];

/**
 * What the hospital's cash register sessions opened today took, net of refunds, with the split by
 * payment mode. Amounts only: no patient, invoice or payer. Default export: a `dashboard.widgets`
 * contribution. A drawer opened on an earlier day is counted on that day.
 */
export default function CollectedTodayWidget() {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const sessions = useRegisterSessions(PAGE);

  const figures = useMemo(() => {
    if (!sessions.data) return undefined;
    const { start, end } = dayBoundsUtc(todayIn(timezone), timezone);
    const byMethod = new Map<RegisterTotal['method'], number>();
    for (const page of sessions.data.pages) {
      for (const session of page.items) {
        if (session.openedAt < start || session.openedAt >= end) continue;
        for (const total of session.totals) {
          byMethod.set(total.method, (byMethod.get(total.method) ?? 0) + netOf(total));
        }
      }
    }
    const split = METHODS.filter((method) => byMethod.has(method)).map((method) => ({
      method,
      minor: byMethod.get(method) ?? 0,
    }));
    return { split, total: split.reduce((sum, each) => sum + each.minor, 0) };
  }, [sessions.data, timezone]);

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
