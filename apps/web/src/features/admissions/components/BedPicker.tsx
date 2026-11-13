import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { useServicePrices } from '@/features/services';
import { useBedCategories } from '@/features/wards';
import { useFormatters } from '@/tenancy';
import { errorMessageKey } from '@/shared/api';
import { useAvailableBeds } from '../hooks/use-admissions';
import { WardFilter } from './WardFilter';

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
  invalid,
  patientId,
}: {
  /** Whom the bed is for: a bed held for another patient is not offered. */
  patientId?: string;
  value: string;
  onChange: (bedId: string) => void;
  describedBy?: string;
  invalid?: boolean;
}) {
  const { t } = useTranslation('admissions');
  const { t: tCommon } = useTranslation();
  const groupId = useId();
  const [wardId, setWardId] = useState('');
  const [category, setCategory] = useState('');
  const mayWards = usePermission('ward:read');
  const beds = useAvailableBeds(wardId);
  const format = useFormatters();
  // The day price of a category: category by name, its bed-day service, that service's price.
  // Each step needs its own permission; without one the price is left out, never an error.
  const categoryList = useBedCategories(false, mayWards);
  const prices = useServicePrices('bed');
  const priceOf = (categoryName: string): number | undefined => {
    const serviceId = categoryList.data?.find((c) => c.name === categoryName)?.serviceId;
    return serviceId ? prices.data?.get(serviceId) : undefined;
  };

  const categories = useMemo(
    () => [...new Set((beds.data ?? []).map((bed) => bed.categoryName))].sort(),
    [beds.data],
  );
  const shown = (beds.data ?? []).filter(
    (bed) =>
      (!category || bed.categoryName === category) &&
      (!bed.reservation || bed.reservation.patientId === patientId),
  );

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-sm font-medium">{t('admit.bed')}</legend>
      <div className="flex flex-wrap gap-4">
        <WardFilter
          value={wardId}
          onChange={(id) => {
            setWardId(id);
            setCategory('');
            onChange('');
          }}
        />
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
        <div
          role="radiogroup"
          aria-label={t('admit.bed')}
          aria-required="true"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        >
          <ul className="grid gap-2 sm:grid-cols-2">
            {shown.map((bed) => {
              return (
                <li key={bed.id}>
                  {/* The text is in nested spans, which the rule does not follow; the input is inside the label. */}
                  {}
                  <label className="group flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent pointer-coarse:min-h-11">
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
                      <span className="block text-muted-foreground group-has-[:checked]:text-foreground">
                        {bed.roomName} · {bed.categoryName}
                      </span>
                      {bed.reservation && (
                        <span className="block text-foreground">{t('admit.heldForThem')}</span>
                      )}
                      {priceOf(bed.categoryName) !== undefined && (
                        <span className="block text-muted-foreground group-has-[:checked]:text-foreground">
                          {t('admit.dayPrice', {
                            price: format.money(priceOf(bed.categoryName) ?? 0),
                          })}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </fieldset>
  );
}
