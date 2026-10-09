import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { useLatestNotices } from '../hooks/use-notices';

const WIDGET_COUNT = 3;

// Default export: contributed to the `dashboard.widgets` slot through the manifest.
export default function LatestNoticesWidget() {
  const { t } = useTranslation('notices');
  const { t: tCommon } = useTranslation();
  const latest = useLatestNotices(WIDGET_COUNT);

  return (
    <section aria-labelledby="latest-notices-title" className="rounded-lg border p-4">
      <h2 id="latest-notices-title" className="mb-2 text-sm font-medium">
        {t('widget.title')}
      </h2>
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
