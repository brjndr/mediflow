import { useTranslation } from 'react-i18next';
import { Slot, useSlotContributions } from '@/registry';

/** The sections that modules contribute to `settings.sections`, one after another. */
export default function SettingsPage() {
  const { t } = useTranslation('hospital-settings');
  const sections = useSlotContributions('settings.sections');
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('heading')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </header>
      {sections.length === 0 ? <p className="text-sm">{t('none')}</p> : null}
      <Slot id="settings.sections" />
    </div>
  );
}
