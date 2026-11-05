import { useTranslation } from 'react-i18next';

/** The platform landing page. The hospital screens that fill it come with PL-02 onwards. */
export default function PlatformHome() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 p-4 md:p-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('platform.home.title')}</h1>
      <p className="max-w-prose text-muted-foreground">{t('platform.home.description')}</p>
    </div>
  );
}
