import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { useAvailableBeds } from '../hooks/use-admissions';
import { useWardOptions } from '../hooks/use-board';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

/**
 * The beds free right now, by ward and category. Only an available bed can be chosen, and a
 * hospital with none free says so (the form then cannot be submitted). The server decides in the
 * end: a bed taken meanwhile is refused.
 */
export function BedPicker({
  value,
  onChange,
  describedBy,
}: {
  value: string;
  onChange: (bedId: string) => void;
  describedBy?: string;
}) {
  const { t } = useTranslation('admissions');
  const { t: tCommon } = useTranslation();
  const groupId = useId();
  const [wardId, setWardId] = useState('');
  const [category, setCategory] = useState('');
  const mayWards = usePermission('ward:read');
  const wards = useWardOptions(mayWards);
  const beds = useAvailableBeds(wardId);

  const categories = useMemo(
    () => [...new Set((beds.data ?? []).map((bed) => bed.categoryName))].sort(),
    [beds.data],
  );
  const shown = (beds.data ?? []).filter((bed) => !category || bed.categoryName === category);

  return (
    <fieldset className="flex flex-col gap-3" aria-describedby={describedBy}>
      <legend className="text-sm font-medium">{t('admit.bed')}</legend>
      <div className="flex flex-wrap gap-4">
        {mayWards && wards.isSuccess && (
          <label className="flex min-w-48 flex-col gap-1 text-sm font-medium">
            {t('filters.ward')}
            <select
              value={wardId}
              onChange={(event) => {
                setWardId(event.target.value);
                setCategory('');
                onChange('');
              }}
              className={control}
            >
              <option value="">{t('filters.allWards')}</option>
              {wards.data.map((ward) => (
                <option key={ward.id} value={ward.id}>
                  {ward.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex min-w-48 flex-col gap-1 text-sm font-medium">
          {t('admit.category')}
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className={control}
          >
            <option value="">{t('admit.allCategories')}</option>
            {categories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {beds.isPending && <p className="text-sm text-muted-foreground">{t('admit.loadingBeds')}</p>}
      {beds.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(beds.error))}
        </p>
      )}
      {beds.isSuccess && shown.length === 0 && (
        <p role="status" className="text-sm font-medium text-destructive">
          {t('admit.noBeds')}
        </p>
      )}
      {shown.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {shown.map((bed) => {
            return (
              <li key={bed.id}>
                {/* The text is in nested spans, which the rule does not follow; the input is inside the label. */}
                {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
                <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent pointer-coarse:min-h-11">
                  <input
                    type="radio"
                    name={groupId}
                    checked={value === bed.id}
                    onChange={() => onChange(bed.id)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block font-medium">
                      {t('admit.bedOption', { number: bed.number, ward: bed.wardName })}
                    </span>
                    <span className="block text-muted-foreground">
                      {bed.roomName} · {bed.categoryName}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}
