import { CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { useWidgetStrings } from '@/shared/hooks/use-widget-strings';
import { RingGauge } from '@/shared/ui/ring-gauge';
import { Skeleton } from '@/shared/ui/skeleton';
import { Stat, StatCard } from '@/shared/ui/stat-card';
import { useOpdCapacity } from '../hooks/use-opd-capacity';
import widgetStrings from '../widget-strings.json';
const loadHindi = () => import('../widget-strings.hi.json');

/**
 * How full today's OPD is (#1126): the share of today's slots that are booked as a ring, with the
 * queue's waiting and in-consult counts and the slots still free. Counts only; no patient or
 * doctor is read or shown. A day with no working hours says so instead of 0%. Default export: a
 * `dashboard.widgets` contribution.
 */
export default function OpdCapacityWidget() {
  const { t } = useWidgetStrings('appointments-widget', widgetStrings, loadHindi);
  const { t: tCommon } = useTranslation();
  const capacity = useOpdCapacity();
  const data = capacity.data;
  const percent = data && data.slots > 0 ? Math.round((data.booked / data.slots) * 100) : 0;
  const tone = percent >= 95 ? 'danger' : percent >= 85 ? 'warning' : 'success';

  return (
    <StatCard
      id="widget-opd-capacity"
      icon={CalendarClock}
      accent={2}
      title={t('widget.title')}
      to="/appointments"
      linkLabel={t('widget.open')}
    >
      {capacity.isError ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {tCommon(errorMessageKey(capacity.error))}
        </p>
      ) : !data ? (
        <Skeleton className="size-24 rounded-full" />
      ) : data.slots === 0 ? (
        <p className="text-sm text-muted-foreground">{t('widget.empty')}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-col items-center gap-1">
            <RingGauge value={percent} tone={tone} label={t('widget.gauge')} />
            <p className="text-sm text-muted-foreground">
              {t('widget.detail', { booked: data.booked, slots: data.slots })}
            </p>
          </div>
          <div className="flex min-w-40 flex-1 flex-col gap-1">
            {data.waiting !== undefined && (
              <Stat label={t('widget.waiting')} value={data.waiting} unknown="" />
            )}
            {data.inConsult !== undefined && (
              <Stat label={t('widget.inConsult')} value={data.inConsult} unknown="" />
            )}
            <Stat label={t('widget.free')} value={data.free} unknown="" />
          </div>
        </div>
      )}
    </StatCard>
  );
}
