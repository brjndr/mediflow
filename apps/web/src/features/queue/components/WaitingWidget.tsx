import { useTranslation } from 'react-i18next';
import { useWidgetStrings } from '@/shared/hooks/use-widget-strings';
import widgetStrings from '../widget-strings.json';
import { errorMessageKey } from '@/shared/api';
import { Stat, StatCard } from '@/shared/ui/stat-card';
import { useQueueTokens } from '../hooks/use-queue';

// Default export: contributed to the `dashboard.widgets` slot through the manifest.
export default function WaitingWidget() {
  const { t } = useWidgetStrings('queue-widget', widgetStrings);
  const { t: tCommon } = useTranslation();
  // One row is read for the total that comes with the first page; nothing about a patient is shown.
  const waiting = useQueueTokens(
    { departmentId: '', doctorId: '', status: 'waiting' },
    // `live` here only means "do not poll": every read of a row is audited, and a panel left open
    // would write an entry for a patient nobody saw on each poll. It reads when it opens.
    { enabled: true, live: true, pageSize: 1 },
  );
  const total = waiting.data?.pages[0]?.total;

  return (
    <StatCard id="widget-queue" title={t('widget.title')} to="/queue" linkLabel={t('widget.open')}>
      {waiting.isError ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {tCommon(errorMessageKey(waiting.error))}
        </p>
      ) : (
        <Stat label={t('widget.waiting')} value={total} unknown={t('widget.unknown')} />
      )}
    </StatCard>
  );
}
