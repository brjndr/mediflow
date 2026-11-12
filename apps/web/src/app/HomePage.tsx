import { useTranslation } from 'react-i18next';
import { Slot, useSlotContributions, type WidgetSize } from '@/registry';

import { useHealth } from '@/shared/api/health';
import { Button } from '@/shared/ui/button';
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
  const health = useHealth();
  const widgets = useSlotContributions('dashboard.widgets');
  const status = health.isPending
    ? t('home.status.checking')
    : health.isError || health.data.status !== 'ok'
      ? t('home.status.unreachable')
      : t('home.status.ok');

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">{t('home.title')}</h1>
        <p className="text-muted-foreground">{t('home.description')}</p>
      </div>
      {widgets.length === 0 ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">{t('home.empty')}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-12">
          <Slot
            id="dashboard.widgets"
            frame={(contribution, node) => (
              <div className={`min-w-0 [&>*]:h-full ${TILE_SPAN[contribution.size ?? 'sm']}`}>
                {node}
              </div>
            )}
            fallback={<Skeleton className="h-28 border" />}
            errorFallback={
              <p role="alert" className="rounded-lg border p-4 text-sm text-muted-foreground">
                {t('home.widgetFailed')}
              </p>
            }
          />
        </div>
      )}
      <p className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>
          {t('home.apiStatus')} <strong data-testid="api-status">{status}</strong>
        </span>
        <Button size="sm" variant="outline" onClick={() => health.refetch()}>
          {t('home.recheck')}
        </Button>
      </p>
    </div>
  );
}
