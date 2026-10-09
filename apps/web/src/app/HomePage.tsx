import { Activity } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useHealth } from '@/shared/api/health';
import { Button } from '@/shared/ui/button';

/** Placeholder landing screen until login (A-01) and the registry routes (F-08) exist. */
export function HomePage() {
  const { t } = useTranslation();
  const health = useHealth();
  const status = health.isPending
    ? t('home.status.checking')
    : health.isError || health.data.status !== 'ok'
      ? t('home.status.unreachable')
      : t('home.status.ok');

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-4">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">{t('home.title')}</h1>
        <p className="text-muted-foreground">{t('home.description')}</p>
      </div>
      <div className="flex items-center gap-3 rounded-lg border p-4">
        <Activity aria-hidden className="size-5 text-primary" />
        <span className="text-sm">
          {t('home.apiStatus')} <strong data-testid="api-status">{status}</strong>
        </span>
        <Button className="ml-auto" size="sm" variant="outline" onClick={() => health.refetch()}>
          {t('home.recheck')}
        </Button>
      </div>
    </div>
  );
}
