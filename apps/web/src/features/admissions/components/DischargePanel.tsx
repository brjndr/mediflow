import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { DISCHARGE_TYPES, type Admission, type DischargeType } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

/** Ending one stay: how it ends, then confirm. The server decides whether the patient may go. */
export function DischargePanel({
  admission,
  pending,
  onSubmit,
  onBack,
}: {
  admission: Admission;
  pending: boolean;
  onSubmit: (type: DischargeType) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation('admissions');
  const [type, setType] = useState<DischargeType>('routine');
  return (
    <section
      aria-labelledby="admission-discharge-heading"
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <h2
        id="admission-discharge-heading"
        data-panel-heading
        tabIndex={-1}
        className="rounded-sm text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {t('discharge.heading', { patient: admission.patientName })}
      </h2>
      <p className="text-sm text-muted-foreground">{t('discharge.description')}</p>
      <label className="flex max-w-xs flex-col gap-1 text-sm font-medium">
        {t('discharge.type')}
        <select
          value={type}
          onChange={(event) => setType(event.target.value as DischargeType)}
          className={control}
        >
          {DISCHARGE_TYPES.map((each) => (
            <option key={each} value={each}>
              {t(`discharge.types.${each}`)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          aria-disabled={pending || undefined}
          onClick={() => {
            if (!pending) onSubmit(type);
          }}
        >
          {t('discharge.submit')}
        </Button>
        <Button type="button" variant="outline" onClick={onBack}>
          {t('discharge.back')}
        </Button>
      </div>
    </section>
  );
}
