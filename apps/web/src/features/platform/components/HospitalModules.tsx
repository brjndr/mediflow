import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { useModules, useSetHospitalFeatures } from '../hooks/use-hospitals';
import { MFA_REQUIRED_SWITCH, MFA_SWITCH, useModuleName } from '../modules';
import type { Hospital } from '../types';

const box =
  'size-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:size-6';
const row = 'flex min-h-8 items-center gap-2 text-sm pointer-coarse:min-h-11';

/** The module flags and the authenticator switches of one hospital. */
export function HospitalModules({ hospital }: { hospital: Hospital }) {
  const { t } = useTranslation();
  const save = useSetHospitalFeatures(hospital.id);
  const modules = useModules();
  const moduleName = useModuleName();
  const saved = new Map(hospital.features.map((f) => [f.feature, f.enabled]));
  // What is ticked now, where the person has touched it.
  const [edits, setEdits] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState(false);

  const isOn = (feature: string) => edits[feature] ?? saved.get(feature) ?? false;
  const changed = Object.entries(edits).filter(
    ([feature, on]) => (saved.get(feature) ?? false) !== on,
  );

  // Modules the API offers, then any other flag the hospital holds, so none is hidden.
  const known: string[] = modules.data ?? [];
  const others = hospital.features
    .map((f) => f.feature)
    .filter((f) => !known.includes(f) && f !== MFA_SWITCH && f !== MFA_REQUIRED_SWITCH);
  // A flag the web app has no name for is shown by its id.
  const name = moduleName;

  const set = (feature: string, on: boolean) => {
    setDone(false);
    setEdits((current) => ({
      ...current,
      [feature]: on,
      // The compulsory switch goes off with the authenticator, at the same save.
      ...(feature === MFA_SWITCH && !on ? { [MFA_REQUIRED_SWITCH]: false } : {}),
    }));
  };

  const mfaOn = isOn(MFA_SWITCH);
  const submit = () => {
    if (changed.length === 0 || save.isPending) return;
    const request = changed.map(([feature, enabled]) => ({ feature, enabled }));
    save.mutate(request, {
      onSuccess: () => {
        setEdits({});
        setDone(true);
      },
    });
  };

  return (
    <section aria-labelledby="hospital-modules" className="flex flex-col gap-3">
      <h2 id="hospital-modules" className="text-lg font-semibold">
        {t('platform.detail.modules')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('platform.detail.modulesHint')}</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">{t('platform.detail.modules')}</legend>
          {modules.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t(errorMessageKey(modules.error))}
            </p>
          )}
          <div className="grid gap-x-4 sm:grid-cols-2">
            {[...known, ...others].map((feature) => (
              <label key={feature} className={row}>
                <input
                  type="checkbox"
                  className={box}
                  checked={isOn(feature)}
                  onChange={(event) => set(feature, event.target.checked)}
                />
                {name(feature)}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">{t('platform.detail.mfa')}</legend>
          <label className={row}>
            <input
              type="checkbox"
              className={box}
              checked={mfaOn}
              onChange={(event) => set(MFA_SWITCH, event.target.checked)}
            />
            {t('platform.detail.mfaOffer')}
          </label>
          <label className={row}>
            <input
              type="checkbox"
              className={box}
              checked={mfaOn && isOn(MFA_REQUIRED_SWITCH)}
              aria-disabled={!mfaOn || undefined}
              onChange={(event) => {
                if (mfaOn) set(MFA_REQUIRED_SWITCH, event.target.checked);
              }}
            />
            {t('platform.detail.mfaRequired')}
          </label>
        </fieldset>
        {save.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t(errorMessageKey(save.error))}
          </p>
        )}
        <p role="status" className="text-sm text-muted-foreground">
          {done ? t('platform.detail.modulesSaved') : ''}
        </p>
        <div>
          <Button
            type="submit"
            aria-disabled={changed.length === 0 || save.isPending || undefined}
            aria-busy={save.isPending}
          >
            {t('platform.detail.saveModules')}
          </Button>
        </div>
      </form>
    </section>
  );
}
