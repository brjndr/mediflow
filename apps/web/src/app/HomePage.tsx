import { useTranslation } from 'react-i18next';
import { Slot, useSlotContributions, type WidgetSize } from '@/registry';

import { useFormatters, useTenant } from '@/tenancy';
import { hourIn, todayIn } from '@/shared/utils';
import { Skeleton } from '@/shared/ui/skeleton';

// Phone: one column. md: two. lg: twelve, where a tile spans 3, 6 or 8. Written out in full so
// Tailwind sees the classes.
const TILE_SPAN: Record<WidgetSize, string> = {
  sm: 'lg:col-span-3',
  md: 'md:col-span-2 lg:col-span-6',
  lg: 'md:col-span-2 lg:col-span-8',
};

/**
 * The landing screen: what the enabled features contribute to `dashboard.widgets`, filtered by
 * flag and permission, so each role sees its own. The page knows no feature by name. A widget
 * that fails shows a notice in its place and the others carry on.
 */
export function HomePage() {
  const { t } = useTranslation();
  const format = useFormatters();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const widgets = useSlotContributions('dashboard.widgets');
  // The day and the hour are the hospital's, whatever the browser's clock says (#1123).
  const now = new Date();
  const hour = hourIn(timezone, now);
  const greeting =
    hour < 12
      ? t('home.greeting.morning')
      : hour < 17
        ? t('home.greeting.afternoon')
        : t('home.greeting.evening');

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4">
      {/* A banner in the hospital's gradient (#1119). Its circles are tinted away from the text colour, as the gradient is, so contrast only rises under them. */}
      <div className="relative mt-4 space-y-2 overflow-hidden rounded-2xl bg-brand-gradient px-5 py-5 text-primary-foreground shadow-button md:px-6 md:py-6">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-20 size-64 rounded-full bg-[color-mix(in_oklab,oklch(from_var(--primary-foreground)_calc(1_-_l)_0_0)_14%,transparent)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-24 right-24 size-48 rounded-full bg-[color-mix(in_oklab,oklch(from_var(--primary-foreground)_calc(1_-_l)_0_0)_14%,transparent)]"
        />
        <p className="relative text-sm font-medium">{greeting}</p>
        <h1 className="relative text-2xl font-semibold tracking-tight md:text-4xl">
          {t('home.title')}
        </h1>
        <p className="relative font-display text-lg font-medium md:text-xl">
          <time dateTime={todayIn(timezone, now)}>{format.fullDate(now)}</time>
        </p>
        <p className="relative">{t('home.description')}</p>
      </div>
      {widgets.length === 0 ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">{t('home.empty')}</p>
      ) : (
        // Each tile gets a top edge in one of the five accent hues, in turn.
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-12 [&>*>*]:border-t-4 [&>:nth-child(5n+1)>*]:border-t-accent-1 [&>:nth-child(5n+2)>*]:border-t-accent-2 [&>:nth-child(5n+3)>*]:border-t-accent-3 [&>:nth-child(5n+4)>*]:border-t-accent-4 [&>:nth-child(5n+5)>*]:border-t-accent-5">
          <Slot
            id="dashboard.widgets"
            frame={(contribution, node) => (
              <div
                className={`min-h-44 min-w-0 [&>*]:h-full ${TILE_SPAN[contribution.size ?? 'sm']}`}
              >
                {node}
              </div>
            )}
            fallback={<Skeleton className="h-full min-h-44 border" />}
            errorFallback={
              <p role="alert" className="rounded-lg border p-4 text-sm text-muted-foreground">
                {t('home.widgetFailed')}
              </p>
            }
          />
        </div>
      )}
    </div>
  );
}
