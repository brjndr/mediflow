import { Megaphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWidgetStrings } from '@/shared/hooks/use-widget-strings';
import { cn } from '@/shared/lib/utils';
import { cardVariants } from '@/shared/ui/card';
import { WidgetHeading } from '@/shared/ui/stat-card';
import widgetStrings from '../widget-strings.json';
import { errorMessageKey } from '@/shared/api';
import { useLatestNotices } from '../hooks/use-notices';
const loadHindi = () => import('../widget-strings.hi.json');

const WIDGET_COUNT = 3;

// Default export: contributed to the `dashboard.widgets` slot through the manifest.
export default function LatestNoticesWidget() {
  const { t } = useWidgetStrings('notices-widget', widgetStrings, loadHindi);
  const { t: tCommon } = useTranslation();
  const latest = useLatestNotices(WIDGET_COUNT);

  return (
    <section
      aria-labelledby="latest-notices-title"
      className={cn(cardVariants(), 'flex flex-col gap-2')}
    >
      <WidgetHeading
        id="latest-notices-title"
        title={t('widget.title')}
        icon={Megaphone}
        accent={2}
      />
      {latest.isPending && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
      {latest.isError && (
        <p role="alert" className="text-sm text-muted-foreground">
          {tCommon(errorMessageKey(latest.error))}
        </p>
      )}
      {latest.isSuccess && latest.data.items.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('widget.empty')}</p>
      )}
      {latest.isSuccess && latest.data.items.length > 0 && (
        <ul className="space-y-1 text-sm">
          {latest.data.items.map((notice) => (
            <li key={notice.id} className="truncate">
              {notice.title}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
