import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { useWidgetStrings } from '@/shared/hooks/use-widget-strings';
import { Stat, StatCard } from '@/shared/ui/stat-card';
import widgetStrings from '../widget-strings.json';
import { useIncompleteRecords } from '../hooks/use-records';

// Default export: contributed to the `dashboard.widgets` slot through the manifest. One row is
// asked for; the count is the page's `total`.
export default function RecordsWidget() {
  const { t } = useWidgetStrings('records-widget', widgetStrings);
  const { t: tCommon } = useTranslation();
  const incomplete = useIncompleteRecords({ gap: '', kind: '' }, 1);

  return (
    <StatCard
      id="widget-records"
      title={t('widget.title')}
      to="/records"
      linkLabel={t('widget.open')}
    >
      {incomplete.error ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {tCommon(errorMessageKey(incomplete.error))}
        </p>
      ) : (
        <Stat
          label={t('stat.incomplete')}
          value={incomplete.data?.pages[0]?.total}
          unknown={t('widget.unknown')}
        />
      )}
    </StatCard>
  );
}
