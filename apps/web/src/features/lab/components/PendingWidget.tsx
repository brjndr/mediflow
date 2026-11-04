import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Stat, StatCard } from '@/shared/ui/stat-card';
import { useWorklist } from '../hooks/use-lab';

// Default export: contributed to the `dashboard.widgets` slot through the manifest.
export default function PendingWidget() {
  const { t } = useTranslation('lab');
  const { t: tCommon } = useTranslation();
  const toCollect = useWorklist({ stage: 'to_collect', priority: '' }, 1);
  const received = useWorklist({ stage: 'received', priority: '' }, 1);
  const error = toCollect.error ?? received.error;

  return (
    <StatCard id="widget-lab" title={t('widget.title')} to="/lab" linkLabel={t('widget.open')}>
      {error ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {tCommon(errorMessageKey(error))}
        </p>
      ) : (
        <>
          <Stat
            label={t('stage.to_collect')}
            value={toCollect.data?.pages[0]?.total}
            unknown={t('widget.unknown')}
          />
          <Stat
            label={t('stage.received')}
            value={received.data?.pages[0]?.total}
            unknown={t('widget.unknown')}
          />
        </>
      )}
    </StatCard>
  );
}
