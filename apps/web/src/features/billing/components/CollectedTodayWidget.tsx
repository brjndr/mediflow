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
import { WidgetLink } from '@/shared/ui/stat-card';
const loadHindi = () => import('../widget-strings.hi.json');

const METHODS: RegisterTotal['method'][] = ['cash', 'card', 'upi', 'bank', 'other'];

/**
 * The fill of each share, largest first: the card's own text colour at falling strength, so the
 * segments differ by lightness and never by hue, and follow the brand colour in light and dark.
 * Every segment is outlined in that text colour, which the theme already holds to text contrast on
 * the brand gradient, so each one's edge is visible whatever its fill.
 */
const SHADES = [
  'bg-primary-foreground',
  'bg-primary-foreground/60',
  'bg-primary-foreground/30',
  'bg-primary-foreground/10',
  'bg-transparent',
];

/**
 * What the hospital took today, net of refunds, with the split by payment mode, from
 * `GET /cash-registers/collected` (the payments themselves, not register sessions), drawn as a bar
 * of each mode's share with the list as its text. Amounts only:
 * no patient, invoice or payer. Default export: a `dashboard.widgets` contribution.
 */
export default function CollectedTodayWidget() {
  const { t } = useWidgetStrings('billing-widget', widgetStrings, loadHindi);
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const sessions = useCollectedToday();

  const figures = useMemo(() => {
    if (!sessions.data) return undefined;
    const split = METHODS.flatMap((method) => {
      const row = sessions.data.totals.find((each) => each.method === method);
      return row ? [{ method, minor: netOf(row) }] : [];
    });
    // Shares of what was taken: a mode whose refunds outweigh its takings has no share of the bar.
    const taken = split.reduce((sum, each) => sum + Math.max(each.minor, 0), 0);
    const shades = new Map(
      split
        .filter((each) => each.minor > 0)
        .sort((a, b) => b.minor - a.minor)
        .map((each, index) => [each.method, SHADES[index] ?? SHADES[SHADES.length - 1]]),
    );
    const rows = split.map((each) => ({
      ...each,
      share: taken > 0 && each.minor > 0 ? each.minor / taken : undefined,
      shade: shades.get(each.method),
    }));
    return { split: rows, total: sessions.data.netMinor };
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
              <>
                {/* The list below says the same in words: the bar is a picture of it. */}
                <div aria-hidden="true" className="flex h-3 w-full gap-0.5">
                  {figures.split.map((each) =>
                    each.share === undefined ? null : (
                      <span
                        key={each.method}
                        data-method={each.method}
                        className={`h-full min-w-1.5 rounded-full border border-primary-foreground ${each.shade}`}
                        style={{ flexGrow: each.share, flexBasis: 0 }}
                      />
                    ),
                  )}
                </div>
                <ul className="space-y-1 text-sm">
                  {figures.split.map((each) => (
                    <li key={each.method} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className={`size-2.5 shrink-0 rounded-full border border-primary-foreground ${each.shade ?? 'bg-transparent'}`}
                        />
                        {t(`payment.methods.${each.method}`)}
                      </span>
                      <span className="flex gap-2 tabular-nums">
                        <span>{format.money(each.minor)}</span>
                        {each.share !== undefined && (
                          <span className="min-w-[4ch] text-end">
                            {format.number(each.share, {
                              style: 'percent',
                              maximumFractionDigits: 0,
                            })}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        <WidgetLink to="/billing/register/sessions">{t('collected.open')}</WidgetLink>
      </section>
    </Card>
  );
}
