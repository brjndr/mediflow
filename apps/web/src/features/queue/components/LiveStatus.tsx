import { Radio, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FALLBACK_REFRESH_MS, type useQueueEvents } from '../hooks/use-queue';

/** Whether the queue follows the server's events, said in words and an icon. */
export function LiveStatus({ status }: { status: ReturnType<typeof useQueueEvents> }) {
  const { t } = useTranslation('queue');
  const seconds = FALLBACK_REFRESH_MS / 1000;
  const live = status === 'live';
  const Icon = live ? Radio : RefreshCw;
  return (
    <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <Icon aria-hidden="true" className="size-4" />
      {live
        ? t('live.on')
        : status === 'stopped'
          ? t('live.off', { seconds })
          : status === 'retrying'
            ? t('live.retrying', { seconds })
            : t('live.connecting')}
    </p>
  );
}
