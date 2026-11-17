import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { Switch } from '@/shared/ui/switch';
import { useAdmissionSettings, useSaveAdmissionSettings } from '../hooks/use-admission-settings';

/**
 * The hospital's admission rules (#952), for `admission:configure`, a section of the hospital
 * settings screen (#992, slot `settings.sections`). One switch for now: a discharge waits for a
 * signed discharge summary.
 */
export default function AdmissionSettings() {
  const allowed = usePermission('admission:configure');
  const { t } = useTranslation('admissions');
  const { t: tCommon } = useTranslation();
  const id = useId();
  const settings = useAdmissionSettings(allowed);
  const save = useSaveAdmissionSettings();
  const [saved, setSaved] = useState('');
  if (!allowed) return null;

  const change = async (on: boolean) => {
    setSaved('');
    try {
      await save.mutateAsync({ requireDischargeSummary: on });
      setSaved(on ? t('settings.savedOn') : t('settings.savedOff'));
    } catch {
      // Said below.
    }
  };
  const failed = save.error ?? settings.error;

  return (
    <section aria-labelledby={`${id}-heading`} className="flex max-w-xl flex-col gap-2">
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        {t('settings.heading')}
      </h2>
      <div className="flex items-start gap-3">
        <Switch
          id={`${id}-summary`}
          checked={settings.data?.requireDischargeSummary ?? false}
          aria-disabled={settings.isPending || save.isPending || undefined}
          onCheckedChange={(on) => {
            if (!settings.isPending && !save.isPending) void change(on);
          }}
        />
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor={`${id}-summary`} className="font-medium">
            {t('settings.requireSummary')}
          </label>
          <p className="text-muted-foreground">{t('settings.requireSummaryHelp')}</p>
        </div>
      </div>
      <p role="status" className="text-sm">
        {saved}
      </p>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(failed))}
        </p>
      )}
    </section>
  );
}
