import { useTranslation } from 'react-i18next';
import { useWidgetStrings } from '@/shared/hooks/use-widget-strings';
import widgetStrings from '../widget-strings.json';
import { errorMessageKey } from '@/shared/api';
import { RingGauge } from '@/shared/ui/ring-gauge';
import { Skeleton } from '@/shared/ui/skeleton';
import { StatCard } from '@/shared/ui/stat-card';
import { useOccupancy } from '../hooks/use-census';

/**
 * Bed occupancy as a ring: occupied beds of the beds in use (a blocked bed leaves the rate, as on
 * the census). Counts only; no patient is read or shown. Default export: a `dashboard.widgets`
 * contribution.
 */
export default function CapacityWidget() {
  const { t } = useWidgetStrings('admissions-widget', widgetStrings);
  const { t: tCommon } = useTranslation();
  // Read when it opens: the bed events stream belongs to the board, not to the landing page.
  const occupancy = useOccupancy('', false);

  const count = (status: string) => occupancy.counts.find((each) => each.status === status)?.count;
  const occupied = count('occupied') ?? 0;
  const usable =
    occupancy.counts.reduce((sum, each) => sum + each.count, 0) - (count('blocked') ?? 0);
  const percent = usable > 0 ? Math.round((occupied / usable) * 100) : 0;
  const tone = percent >= 95 ? 'danger' : percent >= 85 ? 'warning' : 'success';

  return (
    <StatCard
      id="widget-capacity"
      title={t('widget.title')}
      to="/census"
      linkLabel={t('widget.open')}
    >
      {occupancy.isError ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {tCommon(errorMessageKey(occupancy.error))}
        </p>
      ) : occupancy.isPending ? (
        <Skeleton className="size-24 rounded-full" />
      ) : usable === 0 ? (
        <p className="text-sm text-muted-foreground">{t('widget.empty')}</p>
      ) : (
        <div className="flex items-center gap-4">
          <RingGauge value={percent} tone={tone} label={t('widget.gauge')} />
          <p className="text-sm text-muted-foreground">
            {t('widget.detail', { occupied, usable })}
          </p>
        </div>
      )}
    </StatCard>
  );
}
