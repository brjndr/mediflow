import { useTranslation } from 'react-i18next';

/** Shown in place of a screen the user may not open. F-10 owns the final design. */
export function ForbiddenPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-2 px-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t('access.forbiddenTitle')}</h1>
      <p className="text-muted-foreground">{t('access.forbiddenDescription')}</p>
    </div>
  );
}
