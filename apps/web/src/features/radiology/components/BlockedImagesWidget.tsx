import { ImageOff, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { StatCard } from '@/shared/ui/stat-card';
import { useWidgetStrings } from '@/shared/hooks/use-widget-strings';
import widgetStrings from '../widget-strings.json';
const loadHindi = () => import('../widget-strings.hi.json');
import { useBlockedImages, useDismissBlockedImage } from '../hooks/use-radiology';

/**
 * Images the person uploaded that the scan blocked (#926), told on the home page whatever screen
 * they were on when it happened, until each is dismissed. The file name only, never the
 * patient. Default export: a `dashboard.widgets` contribution.
 */
export default function BlockedImagesWidget() {
  const { t } = useWidgetStrings('radiology-widget', widgetStrings, loadHindi);
  const { t: tCommon } = useTranslation();
  const blocked = useBlockedImages();
  const dismiss = useDismissBlockedImage();
  const items = blocked.data ?? [];
  const statusLine = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState<'dismissDone' | 'dismissFailed' | null>(null);

  const dismissOne = (id: string) => {
    if (dismiss.isPending) return;
    dismiss.mutate(id, {
      onSuccess: () => setMessage('dismissDone'),
      onError: () => setMessage('dismissFailed'),
      // The row and its button are gone: keep the keyboard on the page.
      onSettled: () => requestAnimationFrame(() => focusIfLost(statusLine.current)),
    });
  };

  return (
    <StatCard id="widget-blocked-images" icon={ImageOff} accent={5} title={t('widget.title')}>
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
                <strong className="font-medium">{one.fileName}</strong>
                <span className="block text-muted-foreground">{t(`widget.${one.status}`)}</span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={t('widget.dismiss', { fileName: one.fileName })}
                aria-disabled={dismiss.isPending || undefined}
                onClick={() => dismissOne(one.id)}
              >
                <X aria-hidden className="size-4" />
                {t('widget.ok')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="mt-2 text-sm text-muted-foreground outline-none"
      >
        {message ? t(`widget.${message}`) : ''}
      </p>
    </StatCard>
  );
}
