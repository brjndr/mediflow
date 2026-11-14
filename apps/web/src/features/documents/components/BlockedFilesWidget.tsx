import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { StatCard } from '@/shared/ui/stat-card';
import { useWidgetStrings } from '@/shared/hooks/use-widget-strings';
import widgetStrings from '../widget-strings.json';
import { useBlockedDocuments, useDismissBlocked } from '../hooks/use-documents';

/**
 * Files the person attached that the scan blocked (#673), told on the home page whatever screen
 * they were on when it happened, until each is dismissed. Title and file name only, never the
 * patient. Default export: a `dashboard.widgets` contribution.
 */
export default function BlockedFilesWidget() {
  const { t } = useWidgetStrings('documents-widget', widgetStrings);
  const { t: tCommon } = useTranslation();
  const blocked = useBlockedDocuments();
  const dismiss = useDismissBlocked();
  const items = blocked.data ?? [];

  return (
    <StatCard id="widget-blocked-files" title={t('widget.title')}>
      {blocked.isError ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {tCommon(errorMessageKey(blocked.error))}
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {blocked.isPending ? t('widget.loading') : t('widget.none')}
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((one) => (
            <li key={one.id} className="flex items-start justify-between gap-2 text-sm">
              <span>
                <strong className="font-medium">{one.title}</strong>
                <span className="block text-muted-foreground">
                  {t(`widget.${one.status}`, { fileName: one.fileName })}
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={t('widget.dismiss', { title: one.title })}
                aria-disabled={dismiss.isPending || undefined}
                onClick={() => {
                  if (!dismiss.isPending) dismiss.mutate(one.id);
                }}
              >
                <X aria-hidden className="size-4" />
                {t('widget.ok')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </StatCard>
  );
}
