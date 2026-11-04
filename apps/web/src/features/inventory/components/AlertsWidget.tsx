import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Stat, StatCard } from '@/shared/ui/stat-card';
import { useAlertCounts } from '../hooks/use-inventory';
import { EXPIRING_DEFAULT } from '../schemas';

// Default export: contributed to the `dashboard.widgets` slot through the manifest.
export default function AlertsWidget() {
  const { t } = useTranslation('inventory');
  const { t: tCommon } = useTranslation();
  const counts = useAlertCounts({ locationId: '', expiringWithinDays: EXPIRING_DEFAULT });

  return (
    <StatCard
      id="widget-inventory"
      title={t('widget.title')}
      to="/inventory"
      linkLabel={t('widget.open')}
    >
      {counts.isError ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {tCommon(errorMessageKey(counts.error))}
        </p>
      ) : (
        <>
          <Stat label={t('widget.low')} value={counts.data?.low} unknown={t('widget.unknown')} />
          <Stat
            label={t('widget.expiring')}
            value={counts.data?.expiring}
            unknown={t('widget.unknown')}
          />
        </>
      )}
    </StatCard>
  );
}
